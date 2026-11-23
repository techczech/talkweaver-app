// Updating in place (ADR-0044 §7): TalkWeaver checks the developer identity itself before anything reaches
// Squirrel.Mac. Squirrel.Mac only compares the new app with the RUNNING app's designated requirement, and ShipIt
// installs without a quarantine flag, so Gatekeeper and notarisation are never assessed on that path. Here:
//  - the downloaded zip is copied into a private per-attempt folder while its SHA-512 is checked again; that copy is
//    what is checked AND what Squirrel.Mac is later served (re-hashed just before), so the bytes verified are the
//    bytes installed (privateCopy, sha512Matches);
//  - the app extracted from that copy must pass `codesign --verify --deep --strict -R=<requirement>` and Gatekeeper
//    (`spctl -a -t exec`: accepted, "source=Notarized Developer ID", our team as origin; a zero exit alone is not
//    enough);
//  - the running process must itself meet the requirement, or this copy does not update in place at all (a
//    development or unsigned copy would otherwise accept anything signed like itself).
// The requirement names the bundle identifier and the Developer ID team compiled into the app
// (electron.vite.config.ts, UPDATE_SIGNER: read from the signing configuration, never from a keychain).
// Free of Electron: tested in plain Node with stubbed tools (scripts/test-update-signature.mjs).
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import type { FailReason } from '../shared/update-install.ts'

/** The identity every TalkWeaver build for this channel is signed with. */
export interface Signer {
  bundleId: string
  team: string
}

/** The compiled-in identity, or null when it is missing or malformed (then nothing updates in place). */
export function validSigner(value: unknown): Signer | null {
  const v = value as Partial<Signer> | null
  if (!v || typeof v !== 'object') return null
  if (typeof v.bundleId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,200}$/.test(v.bundleId)) return null
  if (typeof v.team !== 'string' || !/^[A-Z0-9]{10}$/.test(v.team)) return null
  return { bundleId: v.bundleId, team: v.team }
}

/**
 * The code requirement: this bundle identifier, an Apple-issued chain whose intermediate is the Developer ID CA
 * (1.2.840.113635.100.6.2.6) and whose leaf is a Developer ID Application certificate (1.2.840.113635.100.6.1.13),
 * of this team. The same shape as the designated requirement the release build carries.
 */
export function signerRequirement(s: Signer): string {
  return `identifier "${s.bundleId}" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "${s.team}"`
}

export const CODESIGN = '/usr/bin/codesign'
export const SPCTL = '/usr/sbin/spctl'
export const DITTO = '/usr/bin/ditto'

/** One run of a tool: its exit status (null when it did not exit normally), any spawn error, and what it printed. */
export interface ToolResult {
  status: number | null
  error?: { code?: string; message?: string } | null
  output: string
}
export type Run = (cmd: string, args: readonly string[], timeoutMs: number, signal?: AbortSignal) => Promise<ToolResult>

const OUTPUT_LIMIT = 64 * 1024

/** The real tools: absolute paths, no shell, a time limit, output kept short; an abort (Cancel) kills the tool. */
export const runTool: Run = (cmd, args, timeoutMs, signal) => new Promise((resolve) => {
  let output = ''
  let done = false
  const onAbort = (): void => { try { child.kill('SIGKILL') } catch { /* gone */ } finish({ status: null, error: { code: 'ABORT_ERR', message: `${cmd} was stopped` }, output }) }
  const finish = (r: ToolResult): void => { if (!done) { done = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(r) } }
  if (signal?.aborted) { resolve({ status: null, error: { code: 'ABORT_ERR', message: `${cmd} was not started (stopped)` }, output: '' }); return }
  let child: ReturnType<typeof spawn>
  try { child = spawn(cmd, [...args], { stdio: ['ignore', 'pipe', 'pipe'] }) } catch (error) {
    resolve({ status: null, error: { code: (error as NodeJS.ErrnoException)?.code, message: String((error as Error)?.message ?? error) }, output: '' })
    return
  }
  const keep = (c: Buffer): void => { if (output.length < OUTPUT_LIMIT) output += c.toString('utf8').slice(0, OUTPUT_LIMIT - output.length) }
  child.stdout?.on('data', keep)
  child.stderr?.on('data', keep)
  const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } finish({ status: null, error: { code: 'ETIMEDOUT', message: `${cmd} took too long` }, output }) }, timeoutMs)
  child.on('error', (error: NodeJS.ErrnoException) => finish({ status: null, error: { code: error.code, message: error.message }, output }))
  child.on('close', (code) => finish({ status: code, output }))
  signal?.addEventListener('abort', onAbort, { once: true })
})

/** One check's answer. 'missing': the tool could not be run (absent, not executable, timed out, stopped): never a pass. */
export type CheckOutcome = 'pass' | 'fail' | 'missing' | 'not-required'

/**
 * Gatekeeper's answer is a pass only when it says so in full: a line "<path>: accepted", the line
 * "source=Notarized Developer ID" and an "origin=Developer ID Application: … (<TEAM>)" line. A zero exit with
 * empty or other output, another source (a local rule such as "source=allowed", "Unnotarized Developer ID",
 * "Apple System") or another origin is not.
 */
export function gatekeeperAccepted(output: string, signer: Signer): boolean {
  const lines = output.split('\n').map((l) => l.trim())
  return lines.some((l) => l.endsWith(': accepted'))
    && lines.includes('source=Notarized Developer ID')
    && lines.some((l) => l.startsWith('origin=Developer ID Application: ') && l.endsWith(`(${signer.team})`))
}

const outcomeOf = (r: ToolResult): CheckOutcome => {
  if (r.error || r.status === null) return 'missing'
  return r.status === 0 ? 'pass' : 'fail'
}
const firstLine = (r: ToolResult): string => (r.error?.message ?? r.output).trim().split('\n')[0]?.slice(0, 300) ?? ''

export interface BundleVerdict {
  ok: boolean
  codesign: CheckOutcome
  gatekeeper: CheckOutcome
  detail: string
}

const TOOL_TIMEOUT_MS = 3 * 60 * 1000

/** 'required' in every release build. 'logged' only in the unpublished update-test flavour (never notarised): the
 *  installer passes it under `__TW_UPDATE_TEST__ ?`, which a release build compiles to 'required'. */
export type GatekeeperMode = 'required' | 'logged'

/**
 * The new app: its whole signature (nested code included, strict) satisfies the requirement, and Gatekeeper
 * accepts it to run as notarised Developer ID code of our team (gatekeeperAccepted). In 'logged' mode
 * Gatekeeper is still asked and its answer logged, but the requirement alone decides.
 */
export async function checkBundle(app: string, signer: Signer | null, run: Run, opts: { gatekeeper: GatekeeperMode; signal?: AbortSignal }): Promise<BundleVerdict> {
  if (!signer) return { ok: false, codesign: 'missing', gatekeeper: 'missing', detail: 'no developer identity was compiled into this build' }
  const cs = await run(CODESIGN, ['--verify', '--deep', '--strict', `-R=${signerRequirement(signer)}`, app], TOOL_TIMEOUT_MS, opts.signal)
  const codesign = outcomeOf(cs)
  if (codesign !== 'pass') return { ok: false, codesign, gatekeeper: 'missing', detail: `codesign ${codesign}: ${firstLine(cs)}` }
  const gk = await run(SPCTL, ['-a', '-t', 'exec', '-vv', app], TOOL_TIMEOUT_MS, opts.signal)
  let gatekeeper = outcomeOf(gk)
  if (gatekeeper === 'pass' && !gatekeeperAccepted(gk.output, signer)) gatekeeper = 'fail'
  const gkText = gk.output.replace(/\s+/g, ' ').trim().slice(0, 300) || firstLine(gk) || '(no answer)'
  if (gatekeeper === 'pass') return { ok: true, codesign, gatekeeper, detail: `codesign pass; Gatekeeper: ${gkText}` }
  if (opts.gatekeeper === 'logged' && gatekeeper !== 'missing') return { ok: true, codesign, gatekeeper: 'not-required', detail: `codesign pass; Gatekeeper ${gatekeeper} (not required in this test build): ${gkText}` }
  return { ok: false, codesign, gatekeeper, detail: `Gatekeeper ${gatekeeper}: ${gkText}` }
}

/** The running copy's answer. 'mismatch' is definite (kept for the run); 'unknown' is asked again later. */
export type RunningCopy = 'signed' | 'mismatch' | 'unknown'

/**
 * The running process: does it itself meet the requirement? `codesign --verify -R=<requirement> <pid>` asks the
 * kernel about the code actually running (its dynamic identity), so a copy moved after launch, or Finder metadata
 * and other detritus at the bundle root, which a static --strict check of the bundle refuses, change nothing; it
 * takes milliseconds and never blocks the main process. Exit 3 ("failed to satisfy") and an unsigned process are
 * definite: 'mismatch'. Anything else (a missing tool, a time-out, another error) is 'unknown', never a pass.
 */
export async function checkRunningCopy(pid: number, signer: Signer | null, run: Run): Promise<{ result: RunningCopy; detail: string }> {
  if (!signer) return { result: 'mismatch', detail: 'no developer identity was compiled into this build' }
  if (!Number.isInteger(pid) || pid <= 0) return { result: 'unknown', detail: `no process id (${pid})` }
  const r = await run(CODESIGN, ['--verify', `-R=${signerRequirement(signer)}`, String(pid)], 30_000)
  if (!r.error && r.status === 0) return { result: 'signed', detail: 'codesign pass' }
  if (!r.error && (r.status === 3 || /not signed at all/i.test(r.output))) return { result: 'mismatch', detail: `codesign fail: ${firstLine(r)}` }
  return { result: 'unknown', detail: `codesign ${outcomeOf(r)}: ${firstLine(r)}` }
}

/** The SHA-512 of a file, base64 as the feed states it; null when it cannot be read or the read was stopped. */
async function sha512Of(file: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const hash = createHash('sha512')
    await pipeline(createReadStream(file), new Transform({ transform(chunk, _e, cb) { hash.update(chunk); cb() } }), { signal })
    return hash.digest('base64')
  } catch { return null }
}

/** Whether a file still has the SHA-512 it was verified with: read again in full immediately before serving it. */
export async function sha512Matches(file: string, sha512: string, signal?: AbortSignal): Promise<boolean> {
  return (await sha512Of(file, signal)) === sha512
}

/**
 * Copies the downloaded zip into a new private folder under `workRoot` (mode 0700) as a read-only file (0400),
 * hashing the bytes as they are written; the copy is kept only when they have the feed's SHA-512. Everything
 * after this (the version and identity checks, and Squirrel.Mac's fetch) reads the copy, never the download.
 */
export async function privateCopy(zip: string, sha512: string, workRoot: string, signal?: AbortSignal): Promise<{ copy: string | null; reason: Extract<FailReason, 'mismatch' | 'disk' | 'unverified'> | null; detail: string }> {
  let dir: string
  try { dir = mkdtempSync(join(workRoot, 'verified-')) } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    return { copy: null, reason: code === 'ENOSPC' ? 'disk' : 'unverified', detail: `could not make a private folder: ${code ?? error}` }
  }
  const copy = join(dir, 'update.zip')
  const hash = createHash('sha512')
  try {
    await pipeline(createReadStream(zip), new Transform({ transform(chunk, _e, cb) { hash.update(chunk); cb(null, chunk) } }), createWriteStream(copy, { flags: 'wx', mode: 0o400 }), { signal })
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    const code = (error as NodeJS.ErrnoException)?.code
    return { copy: null, reason: code === 'ENOSPC' ? 'disk' : 'unverified', detail: `the private copy failed: ${code ?? (error as Error)?.message ?? error}` }
  }
  if (hash.digest('base64') !== sha512) {
    rmSync(dir, { recursive: true, force: true })
    return { copy: null, reason: 'mismatch', detail: 'the download changed after it was checked: its SHA-512 is no longer the feed\'s' }
  }
  return { copy, reason: null, detail: 'copied and checked' }
}

export interface ZipVerdict {
  /** null: verified. 'unverified': any check failed or could not run. 'disk': no room to extract it. */
  reason: Extract<FailReason, 'unverified' | 'disk'> | null
  detail: string
}

/**
 * Extracts the verified zip (as Squirrel.Mac will: ditto) into a fresh folder under `workRoot`, finds the one app
 * at its top, checks it (checkBundle), and removes the folder whatever happens.
 */
export async function verifyUpdateZip(zip: string, workRoot: string, signer: Signer | null, opts: { gatekeeper: GatekeeperMode; run?: Run; signal?: AbortSignal }): Promise<ZipVerdict> {
  const run = opts.run ?? runTool
  if (!signer) return { reason: 'unverified', detail: 'no developer identity was compiled into this build' }
  let dir: string
  try { dir = mkdtempSync(join(workRoot, 'signature-check-')) } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    return { reason: code === 'ENOSPC' ? 'disk' : 'unverified', detail: `could not make a folder to check it in: ${code ?? error}` }
  }
  try {
    const x = await run(DITTO, ['-x', '-k', zip, dir], TOOL_TIMEOUT_MS, opts.signal)
    if (x.error || x.status !== 0) {
      return { reason: /no space left|ENOSPC/i.test(`${x.output} ${x.error?.code ?? ''}`) ? 'disk' : 'unverified', detail: `ditto ${outcomeOf(x)}: ${firstLine(x)}` }
    }
    const top = readdirSync(dir).filter((n) => n !== '__MACOSX')
    if (top.length !== 1 || !top[0].endsWith('.app')) return { reason: 'unverified', detail: `expected one app at the top of the zip, found ${JSON.stringify(top.slice(0, 5))}` }
    const app = join(dir, top[0])
    const st = lstatSync(app)
    if (!st.isDirectory() || st.isSymbolicLink()) return { reason: 'unverified', detail: 'the app in the zip is not a folder' }
    const verdict = await checkBundle(app, signer, run, { gatekeeper: opts.gatekeeper, signal: opts.signal })
    return { reason: verdict.ok ? null : 'unverified', detail: verdict.detail }
  } catch (error) {
    return { reason: 'unverified', detail: `the check failed: ${(error as Error)?.message ?? error}` }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* the cache is cleared at every start too */ }
  }
}
