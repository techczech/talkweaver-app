/** Identical contract in both writers; canonical specification:
 * talkweaver-handouts/docs/specs/specification-handouts-publication-preservation-2026-10-31.md.
 * Local coordination only: Pages has no atomic compare-and-deploy operation.
 */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { lstat, readdir, open, copyFile, mkdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export type PreservationReason = 'PUBLISH_COVERAGE_MISSING' | 'PUBLISH_UNRELATED_REMOVAL' | 'PUBLISH_IDENTITY_CHANGED' | 'PUBLISH_CANDIDATE_CHANGED' | 'PUBLISH_REVISION_CHANGED' | 'PUBLISH_INVENTORY_UNAVAILABLE' | 'PUBLISH_BUSY' | 'PUBLISH_OUTCOME_UNKNOWN'
const messages: Record<PreservationReason, string> = {
  PUBLISH_COVERAGE_MISSING: 'Publishing stopped because this computer is missing published files. Restore the complete site folder and try again.',
  PUBLISH_UNRELATED_REMOVAL: 'Publishing stopped because files outside this change would be removed. Restore those files and try again.',
  PUBLISH_IDENTITY_CHANGED: 'The source or publishing connection changed. Review the change and publish again.',
  PUBLISH_CANDIDATE_CHANGED: 'The files prepared for publishing changed or could not be read safely. Prepare the change again.',
  PUBLISH_REVISION_CHANGED: 'The published site changed during this attempt. Review the current site and publish again.',
  PUBLISH_INVENTORY_UNAVAILABLE: 'The complete published site could not be checked. Check the connection and try again.',
  PUBLISH_BUSY: 'Another publish is running, or its lock cannot be checked safely. Wait for it to finish and try again.',
  PUBLISH_OUTCOME_UNKNOWN: 'The result of the earlier publish is still unknown: Cloudflare can take a while to show it. Try again later; nothing is sent until it is known. If it stays like this, follow "Recovering a stuck publish" in the publishing specification (docs/plans/2026-11-05-per-talk-publishing/spec.md).',
}
export function preservationMessage(reason: PreservationReason, path?: string): string {
  return `${path ? `Publishing stopped because the published path ${JSON.stringify(path)} cannot be compared safely. This app cannot repair an existing remote name. Follow the manual remote-path recovery in the publication specification before trying again.` : messages[reason]} (${reason})`
}
export class PreservationRefusal extends Error {
  readonly reason: PreservationReason
  readonly missingCount?: number
  constructor(reason: PreservationReason, path?: string, missingCount?: number) { super(preservationMessage(reason, path)); this.reason = reason; this.missingCount = missingCount }
}
export interface PreservationInventory {
  complete: true; site: string; revision: string; paths: string[]; candidateDigest?: string; rawPaths?: string[]
  /** The production deployment's manifest as Cloudflare keeps it, `[path, asset hash]` with the path exactly as stored (per-talk merge). */
  files?: Array<[string, string]>
  /** The production deployment's own address (`https://<short id>.<site>.pages.dev`), when Cloudflare gave one. */
  deploymentUrl?: string
}
export interface PreservationOptions {
  site: string
  inventory(): Promise<PreservationInventory | null>
  binding(): string | Promise<string>
  approvedBinding: string
  removalPaths?: readonly string[]
  /** Explicit null only for authoring, which approves the bytes just built. */
  candidateDigest: string | null
  storageRoot?: string
  /**
   * Per-talk publishing: what became of an earlier in-process attempt whose outcome is unknown, asked of Cloudflare by its
   * deployment id (kept the moment the request answered) or, its answer lost, by its candidate digest. `deployed` with the id;
   * `pending` and `unknown` keep the journal (the publish is refused until it settles); `not-deployed` discards it.
   */
  reconcile?(attempt: { revision: string; candidateDigest: string; deploymentId?: string; postedAt?: number; sent: boolean }): Promise<{ state: 'deployed'; id: string } | { state: 'not-deployed' | 'pending' | 'unknown' }>
}
const refuse = (reason: PreservationReason, path?: string): never => { throw new PreservationRefusal(reason, path) }
// Deployment file-map keys are opaque names, NOT URLs. Never percent-decode them.
export function publicationPath(value: string): string {
  if (typeof value !== 'string' || /[%?#]/u.test(value) || !value.startsWith('/') || value.endsWith('/') || value.startsWith('//') || /[\\\x00-\x1f\x7f-\x9f\uD800-\uDFFF]/u.test(value) || value.slice(1).split('/').some(p => !p || p === '.' || p === '..')) return refuse('PUBLISH_INVENTORY_UNAVAILABLE', value)
  return value.normalize('NFC')
}
/** A path of the candidate as it will be kept: refused (PUBLISH_CANDIDATE_CHANGED) when it holds %, ? or # or is no plain path. */
export function candidatePath(path: string): string { return localPath(path) }
function localPath(path: string): string {
  if (/[%?#]/u.test(path)) {
    const error = new PreservationRefusal('PUBLISH_CANDIDATE_CHANGED')
    error.message = `Publishing stopped because the local file ${JSON.stringify(path)} contains %, ? or #. Rename it before publishing. Nothing was uploaded. (PUBLISH_CANDIDATE_CHANGED)`
    throw error
  }
  if (!path.startsWith('/') || path.startsWith('//') || path.endsWith('/') || /[\\\x00-\x1f\x7f-\x9f\uD800-\uDFFF]/u.test(path) || path.slice(1).split('/').some(p => !p || p === '.' || p === '..')) return refuse('PUBLISH_CANDIDATE_CHANGED')
  return path.normalize('NFC')
}
/** Exclude only bytes Wrangler itself ignores; controls remain part of the frozen digest. */
function ignored(path: string): boolean {
  return path.split('/').some(p => p === '.DS_Store' || p === '.git' || p === 'node_modules') || path === '/.wrangler' || path.startsWith('/.wrangler/')
}
export function publicationPaths(dir: string): string[] {
  const paths: string[] = []
  const seen = new Set<string>()
  function walk(root: string, prefix: string): void {
    if (!lstatSync(root).isDirectory()) refuse('PUBLISH_CANDIDATE_CHANGED')
    for (const name of readdirSync(root).sort()) {
      const raw = prefix + '/' + name
      if (ignored(raw)) continue
      const path = localPath(raw), full = join(root, name), st = lstatSync(full)
      if (st.isDirectory()) walk(full, raw)
      else { if (paths.length >= 100_000 || seen.has(path)) refuse('PUBLISH_CANDIDATE_CHANGED'); seen.add(path); paths.push(path) }
    }
  }
  walk(dir, '')
  return paths
}
/** A folder built outside the site that is part of the candidate as `/<name>/…`; it enters the site only when the upload launches. */
export interface PublicationOverlay { name: string; dir: string }
interface Tree { digest: string; paths: string[]; files: Array<{ path: string; uploadPath: string; source: string; hash: string }>; controls: Record<string, string> }
const controls = ['/_redirects', '/_headers', '/_routes.json', '/_worker.js', '/functions']
function control(path: string): string | undefined { return controls.find(c => path === c || path.startsWith(c + '/')) }
export function publicationBinding(parts: unknown): string { return createHash('sha256').update(JSON.stringify(parts)).digest('hex') }
/** Four streaming file readers; no synchronous site reads or site-sized byte buffers. */
export async function publicationTree(dir: string, overlays: readonly PublicationOverlay[] = []): Promise<Tree> {
  const files: Tree['files'] = []
  const names = new Set<string>()
  async function walk(root: string, prefix: string): Promise<void> {
    if (!(await lstat(root)).isDirectory()) refuse('PUBLISH_CANDIDATE_CHANGED')
    for (const name of (await readdir(root)).sort()) {
      const raw = prefix + '/' + name
      if (ignored(raw)) continue
      const path = localPath(raw), full = join(root, name), st = await lstat(full)
      if (names.has(path)) refuse('PUBLISH_CANDIDATE_CHANGED')
      names.add(path)
      if (st.isDirectory()) await walk(full, raw)
      else if (st.isFile()) {
        if (files.length >= 100_000) refuse('PUBLISH_CANDIDATE_CHANGED')
        files.push({ path, uploadPath: raw, source: full, hash: '' })
      } else refuse('PUBLISH_CANDIDATE_CHANGED')
    }
  }
  await walk(dir, '')
  // Folders an attempt has built privately and not yet moved into the site: part of the candidate under their site name.
  for (const overlay of overlays) await walk(overlay.dir, '/' + overlay.name)
  let next = 0
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let i = next++; i < files.length; i = next++) {
      const hash = createHash('sha256'), handle = await open(files[i].source, 'r')
      try { for await (const chunk of handle.createReadStream()) hash.update(chunk) }
      finally { await handle.close() }
      files[i].hash = hash.digest('hex')
    }
  }))
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const recorded: Record<string, string> = {}
  for (const c of controls) {
    const rows = files.filter(f => control(f.path) === c).map(f => [f.path, f.hash])
    if (rows.length) recorded[c] = publicationBinding(rows)
  }
  return { digest: publicationBinding(files.map(f => [f.uploadPath, f.hash])), paths: files.map(f => f.path), files, controls: recorded }
}
function checked(value: PreservationInventory | null, site: string): PreservationInventory {
  if (!value || value.complete !== true || typeof value.revision !== 'string' || !value.revision || !Array.isArray(value.paths) || value.paths.length > 100_000) return refuse('PUBLISH_INVENTORY_UNAVAILABLE')
  if (value.site !== site) return refuse('PUBLISH_IDENTITY_CHANGED')
  const paths = value.paths.map(publicationPath)
  if (new Set(paths).size !== paths.length) return refuse('PUBLISH_INVENTORY_UNAVAILABLE')
  return { ...value, paths, rawPaths: value.paths }
}
interface Holder { pid: number; started: string; group?: boolean }
let ownStart: string | undefined
/** This process's own start time cannot change, so ask once (PowerShell takes seconds on a slow Windows computer). */
async function processStart(pid: number): Promise<string | null | undefined> {
  if (pid !== process.pid) return askProcessStart(pid)
  if (ownStart !== undefined) return ownStart
  const value = await askProcessStart(pid)
  if (typeof value === 'string') ownStart = value
  return value
}
async function askProcessStart(pid: number): Promise<string | null | undefined> {
  try { process.kill(pid, 0) } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? null : undefined }
  // The start time is the process's identity (a reused pid has another one). macOS: /bin/ps; Windows has no ps, so
  // ask PowerShell by absolute path (never through PATH) for the same fact.
  const [command, args, limit] = process.platform === 'win32'
    ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${Math.trunc(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`], 15000]
    : ['/bin/ps', ['-p', String(pid), '-o', 'lstart='], 2000]
  return new Promise(resolve => execFile(command as string, args as string[], { timeout: limit as number, windowsHide: true }, (error, stdout) => {
    if (!error && stdout.trim()) resolve(stdout.trim())
    else { try { process.kill(pid, 0); resolve(undefined) } catch (e) { resolve((e as NodeJS.ErrnoException).code === 'ESRCH' ? null : undefined) } }
  }))
}
async function gone(holder: Holder): Promise<boolean> {
  if (!holder || !Number.isSafeInteger(holder.pid) || holder.pid <= 0 || typeof holder.started !== 'string' || !holder.started) return false
  const now = await processStart(holder.pid)
  return now === null || (now !== undefined && now !== holder.started)
}
/** A dead wrapper alone is insufficient: its publishing descendants must be gone too. */
async function childGone(holder: Holder): Promise<boolean> {
  if (!holder?.group || !await gone(holder)) return false
  try { process.kill(-holder.pid, 0); return false }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
}
export const OWNERLESS_LOCK_GRACE_MS = 5000
function durable(path: string, value: unknown, exclusive = false): void {
  const temp = exclusive ? path : path + '.tmp-' + randomUUID()
  const fd = openSync(temp, 'wx', 0o600)
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd) } finally { closeSync(fd) }
  if (!exclusive) renameSync(temp, path)
}
/**
 * `sendsRecorded`: this journal records the moment its deployment request is sent (`postedAt`, written before the request): its
 * absence then proves no request was sent. A journal without it (written before that was recorded) proves nothing either way.
 * `inProcess`: the deployment was created by this app's own requests (the per-talk merge), not by a tool in a process of its
 * own. Its launch is over once the app's call returned (`settled`) or the app that made it is gone; a writer that does not know
 * the field finds no `child` and refuses, as it must.
 */
interface Journal { version: 2; site: string; revision: string; candidateDigest: string; paths: string[]; controls: Record<string, string>; holder: Holder; child?: Holder; inProcess?: true; deploymentId?: string; postedAt?: number; sendsRecorded?: true; launch: 'pending' | 'running' | 'settled'; outcome: 'unknown' }
export interface PublicationLaunch {
  candidateDigest: string
  started(pid: number, group?: boolean): Promise<void>
  /** In-process launches: the deployment request is about to be sent (its time is kept in the journal first). */
  posting?(): void
  /** In-process launches: the deployment request answered with this id (kept in the journal at once). */
  deployed?(id: string): void
}
/** One merged deployment (per-talk publishing): what will be live, described without any local site folder. */
export interface MergedDeployment {
  /** The digest carried in the deployment's commit message (`tw-candidate:<digest>`): the recovery check reads it back. */
  candidateDigest: string
  /** Every path of the new deployment's manifest, as Cloudflare will keep it. */
  paths: readonly string[]
  /** The site-level files sent beside the manifest (`/_redirects`, `/_headers`), each as `publicationBinding([[name, sha256]])`. */
  controls: Record<string, string>
}
export interface PreservationAttempt {
  recovered: boolean
  /** The complete production inventory this attempt began with (checked; `files` and `deploymentUrl` when the reader gave them). */
  live: PreservationInventory
  /**
   * Per-talk publishing: the production deployment is read again (PUBLISH_REVISION_CHANGED when it moved), the source binding is
   * checked, the recovery journal is written, and only then `launch` runs: the app's own requests that upload missing bytes and
   * create the deployment. Nothing of a local site folder is read. The record of what went up is the same file `upload` writes.
   */
  deploy<T>(plan: MergedDeployment, launch: (context: PublicationLaunch) => Promise<{ outcome: 'accepted' | 'failed' | 'unknown'; value: T }>): Promise<T>
  upload<T>(dir: string, before: readonly string[], removalRoots: readonly string[], launch: (frozenDir: string, context: PublicationLaunch) => Promise<{ outcome: 'accepted' | 'failed' | 'unknown'; value: T }>, overlays?: readonly PublicationOverlay[]): Promise<T>
  close(): void
}
/** Where this computer keeps its publication coordination files (shared by both writers). */
export function publicationStorageRoot(storageRoot?: string): string {
  return storageRoot ?? (process.platform === 'win32'
    ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'TalkWeaver Publication', 'v1')
    : join(homedir(), 'Library/Application Support/TalkWeaver Publication/v1'))
}
/**
 * This computer's record of its last accepted publish to `site` (`<binding>.controls.json`, written by `upload` and `deploy`):
 * the production revision it was made against or recovered at, and the candidate digest it carried. Null when there is none or
 * it does not read. Read only: per-talk publishing uses it to decide whether this computer may write a site's first record.
 */
export function readPublicationRecord(site: string, storageRoot?: string): { revision: string; candidateDigest?: string; controls: Record<string, string> } | null {
  try {
    const value = JSON.parse(readFileSync(join(publicationStorageRoot(storageRoot), publicationBinding(site) + '.controls.json'), 'utf8'))
    if (!value || value.site !== site || value.published !== true || typeof value.revision !== 'string' || !value.revision) return null
    const controlsOk = value.controls && typeof value.controls === 'object' && !Array.isArray(value.controls) && Object.values(value.controls).every((digest) => typeof digest === 'string')
    if (!controlsOk) return null
    return { revision: value.revision, controls: value.controls as Record<string, string>, ...(typeof value.candidateDigest === 'string' && /^[0-9a-f]{64}$/u.test(value.candidateDigest) ? { candidateDigest: value.candidateDigest } : {}) }
  } catch { return null }
}
export async function beginPublication(options: PreservationOptions): Promise<PreservationAttempt> {
  const root = publicationStorageRoot(options.storageRoot)
  const key = publicationBinding(options.site), lock = join(root, key + '.lock'), journal = join(root, key + '.json'), record = join(root, key + '.controls.json')
  const token = randomUUID(), started = await processStart(process.pid)
  if (!started) return refuse('PUBLISH_BUSY')
  const holder: Holder = { pid: process.pid, started }
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const owner = lstatSync(root)
    // Windows reports no meaningful Unix mode or owner (every folder reads as 0o777); its per-user app-data folder is the protection.
    const unixOwned = process.platform !== 'win32'
    if (!owner.isDirectory() || owner.isSymbolicLink() || (unixOwned && (owner.mode & 0o022) !== 0) || (unixOwned && process.getuid && owner.uid !== process.getuid())) refuse('PUBLISH_BUSY')
    // Install an already-owned directory atomically: a compliant writer never exposes an empty lock.
    const claim = lock + '.claim-' + token
    mkdirSync(claim, { mode: 0o700 })
    try {
      durable(join(claim, 'owner.json'), { ...holder, token }, true)
      try {
        if (existsSync(lock)) throw new Error('lock exists')
        renameSync(claim, lock)
      } catch {
        // Serialize reclaimers and move the old directory atomically; never unlink a replacement.
        const identity = lstatSync(lock)
        let old: string | null = null
        try { old = readFileSync(join(lock, 'owner.json'), 'utf8') }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        if (old === null ? Date.now() - identity.mtimeMs < OWNERLESS_LOCK_GRACE_MS : !await gone(JSON.parse(old))) refuse('PUBLISH_BUSY')
        const reaper = join(lock, 'reclaim'), retired = lock + '.retired-' + token
        mkdirSync(reaper)
        let moved = false
        try {
          const current = lstatSync(lock)
          if (current.ino !== identity.ino || current.dev !== identity.dev) refuse('PUBLISH_BUSY')
          if (old === null ? existsSync(join(lock, 'owner.json')) : readFileSync(join(lock, 'owner.json'), 'utf8') !== old) refuse('PUBLISH_BUSY')
          renameSync(lock, retired); moved = true
          renameSync(claim, lock)
        } finally {
          if (moved) rmSync(retired, { recursive: true, force: true })
          else rmdirSync(reaper)
        }
      }
    } finally { rmSync(claim, { recursive: true, force: true }) }
  } catch { return refuse('PUBLISH_BUSY') }
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    if (JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).token !== token) return
    rmSync(join(lock, 'owner.json')); rmdirSync(lock)
  }
  try {
    const first = checked(await options.inventory(), options.site)
    let recovered = false
    if (existsSync(journal)) {
      let old: Journal
      try { old = JSON.parse(readFileSync(journal, 'utf8')) } catch { return refuse('PUBLISH_OUTCOME_UNKNOWN') }
      if (old.version !== 2 || old.site !== options.site || !old.revision || !/^[0-9a-f]{64}$/u.test(old.candidateDigest) || !Array.isArray(old.paths)) refuse('PUBLISH_OUTCOME_UNKNOWN')
      // Returning from a runner is not proof of exit (its kill deadline may have expired). An in-process launch is over once its
      // call returned (`settled`) or once the app that made it has gone.
      const over = old.inProcess === true ? (old.launch === 'settled' || await gone(old.holder)) : !!(old.child && await childGone(old.child))
      if (!over) refuse('PUBLISH_OUTCOME_UNKNOWN')
      if (old.inProcess === true && options.reconcile) {
        // An unchanged production revision does not prove the earlier deployment cannot still become production: ask Cloudflare.
        // Sent, unless the journal proves otherwise: it records sends and records none.
        const sent = !(old.sendsRecorded === true && typeof old.postedAt !== 'number' && !old.deploymentId)
        const found = await options.reconcile({ revision: old.revision, candidateDigest: old.candidateDigest, ...(old.deploymentId ? { deploymentId: old.deploymentId } : {}), ...(typeof old.postedAt === 'number' ? { postedAt: old.postedAt } : {}), sent })
        if (found.state === 'pending' || found.state === 'unknown') refuse('PUBLISH_OUTCOME_UNKNOWN')
        if (found.state === 'deployed' && first.revision === found.id) {
          durable(record, { site: options.site, revision: first.revision, candidateDigest: old.candidateDigest, controls: old.controls, published: true })
          recovered = true
        }
        // Not deployed, failed, or deployed and since replaced by a later production deployment: it is over.
        rmSync(journal)
      } else if (first.revision === old.revision) rmSync(journal)
      else if (first.candidateDigest === old.candidateDigest && publicationBinding([...first.paths].sort()) === publicationBinding([...old.paths].sort())) {
        durable(record, { site: options.site, revision: first.revision, candidateDigest: old.candidateDigest, controls: old.controls, published: true })
        rmSync(journal); recovered = true
      } else refuse('PUBLISH_OUTCOME_UNKNOWN')
    }
    if (!options.approvedBinding || await options.binding() !== options.approvedBinding) refuse('PUBLISH_IDENTITY_CHANGED')
    let used = false
    return {
      close, recovered, live: first,
      async deploy(plan, launch) {
        if (used) refuse('PUBLISH_OUTCOME_UNKNOWN')
        used = true
        if (!/^[0-9a-f]{64}$/u.test(plan.candidateDigest) || !Array.isArray(plan.paths) || plan.paths.length > 100_000) refuse('PUBLISH_CANDIDATE_CHANGED')
        const paths = plan.paths.map(publicationPath)
        if (Object.entries(plan.controls).some(([name, digest]) => !controls.includes(name) || !/^[0-9a-f]{64}$/u.test(digest))) refuse('PUBLISH_CANDIDATE_CHANGED')
        const last = checked(await options.inventory(), options.site)
        if (last.revision !== first.revision || publicationBinding([...last.paths].sort()) !== publicationBinding([...first.paths].sort())) refuse('PUBLISH_REVISION_CHANGED')
        if (await options.binding() !== options.approvedBinding) refuse('PUBLISH_IDENTITY_CHANGED')
        const entry: Journal = { version: 2, site: options.site, revision: first.revision, candidateDigest: plan.candidateDigest,
          paths, controls: plan.controls, holder, inProcess: true, sendsRecorded: true, launch: 'running', outcome: 'unknown' }
        durable(journal, entry, true)
        let result
        try { result = await launch({ candidateDigest: plan.candidateDigest, started: async () => {}, posting: () => { entry.postedAt = Date.now(); durable(journal, entry) }, deployed: (id) => { entry.deploymentId = id; durable(journal, entry) } }) }
        catch { entry.launch = 'settled'; durable(journal, entry); return refuse('PUBLISH_OUTCOME_UNKNOWN') }
        entry.launch = 'settled'; durable(journal, entry)
        if (result.outcome === 'unknown') refuse('PUBLISH_OUTCOME_UNKNOWN')
        if (result.outcome === 'accepted') durable(record, { site: options.site, revision: first.revision, candidateDigest: plan.candidateDigest, controls: plan.controls, published: true })
        rmSync(journal)
        return result.value
      },
      async upload(dir, before, removalRoots, launch, overlays = []) {
        if (used) refuse('PUBLISH_OUTCOME_UNKNOWN')
        used = true
        const candidate = await publicationTree(dir, overlays)
        if (options.candidateDigest !== null && (!/^[0-9a-f]{64}$/u.test(options.candidateDigest ?? '') || candidate.digest !== options.candidateDigest)) refuse('PUBLISH_CANDIDATE_CHANGED')
        if (existsSync(record)) {
          let prior
          try { prior = JSON.parse(readFileSync(record, 'utf8')) } catch { return refuse('PUBLISH_INVENTORY_UNAVAILABLE') }
          if (!prior || prior.site !== options.site || !prior.controls || typeof prior.controls !== 'object' || Array.isArray(prior.controls) || Object.entries(prior.controls).some(([name, digest]) => !controls.includes(name) || typeof digest !== 'string' || !/^[0-9a-f]{64}$/u.test(digest))) refuse('PUBLISH_INVENTORY_UNAVAILABLE')
          for (const c of Object.keys(prior.controls)) if (!candidate.controls[c]) refuse('PUBLISH_COVERAGE_MISSING')
        }
        const roots = removalRoots.map(path => localPath(path + '/placeholder').slice(0, -'/placeholder'.length) + '/')
        const present = new Set(candidate.paths), permitted = new Set((options.removalPaths ?? []).map(publicationPath))
        const missing = first.paths.filter(path => !present.has(path) && !permitted.has(path) && !roots.some(root => path.startsWith(root)))
        const initiallyPresent = new Set(before.map(localPath))
        if (missing.length) throw new PreservationRefusal(missing.some(path => initiallyPresent.has(path)) ? 'PUBLISH_UNRELATED_REMOVAL' : 'PUBLISH_COVERAGE_MISSING', undefined, missing.length)
        // NFC is comparison-only. Do not replace an existing differently encoded URL.
        const remoteNames = new Map(first.paths.map((path, index) => [path, first.rawPaths![index]]))
        for (const file of candidate.files) {
          if (remoteNames.has(file.path) && remoteNames.get(file.path) !== file.uploadPath) refuse('PUBLISH_CANDIDATE_CHANGED')
        }
        const scratch = mkdtempSync(join(tmpdir(), 'tw-publication-'))
        try {
          for (const file of candidate.files) {
            const dest = join(scratch, file.uploadPath.slice(1)); await mkdir(join(dest, '..'), { recursive: true })
            await copyFile(file.source, dest)
          }
          if ((await publicationTree(scratch)).digest !== candidate.digest || (await publicationTree(dir, overlays)).digest !== candidate.digest) refuse('PUBLISH_CANDIDATE_CHANGED')
          const last = checked(await options.inventory(), options.site)
          if (last.revision !== first.revision || publicationBinding([...last.paths].sort()) !== publicationBinding([...first.paths].sort())) refuse('PUBLISH_REVISION_CHANGED')
          if ((await publicationTree(scratch)).digest !== candidate.digest || (await publicationTree(dir, overlays)).digest !== candidate.digest) refuse('PUBLISH_CANDIDATE_CHANGED')
          await mkdir(join(scratch, '.wrangler', 'deploy'), { recursive: true })
          durable(join(scratch, '.wrangler', 'publication.json'), { pages_build_output_dir: '..' })
          durable(join(scratch, '.wrangler', 'deploy', 'config.json'), { configPath: '../publication.json' })
          // No awaited preparation follows the last source/site binding check.
          if (await options.binding() !== options.approvedBinding) refuse('PUBLISH_IDENTITY_CHANGED')
          const entry: Journal = { version: 2, site: options.site, revision: first.revision, candidateDigest: candidate.digest,
            paths: candidate.paths.filter(p => !control(p)), controls: candidate.controls, holder, launch: 'pending', outcome: 'unknown' }
          durable(journal, entry, true)
          let result
          try {
            result = await launch(scratch, { candidateDigest: candidate.digest, started: async (pid, group = false) => {
              const began = await processStart(pid)
              if (began !== undefined) { entry.child = { pid, started: began ?? 'exited-before-identity-read', group }; entry.launch = 'running'; durable(journal, entry) }
            } })
          } catch { return refuse('PUBLISH_OUTCOME_UNKNOWN') }
          if (entry.child && await childGone(entry.child)) { entry.launch = 'settled'; durable(journal, entry) }
          if (result.outcome === 'unknown') refuse('PUBLISH_OUTCOME_UNKNOWN')
          if (result.outcome === 'accepted') durable(record, { site: options.site, revision: first.revision, candidateDigest: candidate.digest, controls: candidate.controls, published: true })
          rmSync(journal)
          return result.value
        } finally { rmSync(scratch, { recursive: true, force: true }) }
      }
    }
  } catch (error) {
    close()
    if (error instanceof PreservationRefusal) throw error
    return refuse('PUBLISH_INVENTORY_UNAVAILABLE')
  }
}

/** Fixed pre-deployment refusals only; arbitrary non-zero exits stay uncertain. */
export function definiteWranglerFailure(output: string): boolean {
  if (/Deployment complete|Success!|Uploaded\s+\d+\s+files|Uploading.*(?:100%|complete)/i.test(output)) return false
  return /Missing directory\. Provide the path|Must specify a directory of assets to deploy|Error: Pages only supports (?:files up to|up to [\d,]+ files)/i.test(output)
}

/** Only known pre-upload refusals or a proven no-launch may discard the recovery record. */
export function publicationOutcome(result: { accepted: boolean; interrupted?: boolean; neverStarted?: boolean; output?: string; definiteRefusal?: boolean }): 'accepted' | 'failed' | 'unknown' {
  if (result.neverStarted) return 'failed'
  if (result.interrupted) return 'unknown'
  if (result.accepted) return 'accepted'
  return result.definiteRefusal || definiteWranglerFailure(result.output ?? '') ? 'failed' : 'unknown'
}
