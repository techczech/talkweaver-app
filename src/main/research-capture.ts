// The research-capture verb (knowledge step two): file one reusable unit (a table, a quotation with its
// citation, a visualisation, a search) into `<talk folder>/research/` by calling `scout capture`.
//
// One implementation, two callers (ADR-0019): the "Capture to research…" sheet reaches it through the
// `research:capture` handler, the agent through the `research.capture` verb (agent-verbs.ts). This
// module never writes a file itself: scout writes the Markdown file, appends the manifest line and
// refreshes the index. The one thing done here besides spawning is `revealResearchFolder`, which
// creates an empty `research/` so Finder has something to show.
//
// scout is found on PATH, then at ~/.cargo/bin/scout. It is started with execFile (no shell), with
// the body on stdin, and given thirty seconds.

import { execFile } from 'node:child_process'
import { accessSync, constants, lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, isAbsolute, join } from 'node:path'
import { pickOutlineEntry } from './talk-scan.mjs'
import { pathStaysInside } from './path-containment.ts'
import { inReservedFolder } from './vault-paths.ts'

export const CAPTURE_KINDS = ['evidence', 'table', 'visualisation', 'snippet', 'search', 'widget'] as const
export type CaptureKind = (typeof CAPTURE_KINDS)[number]

export interface CaptureInput {
  /** Absolute path of the talk folder (the folder holding `<slug>-outline.md`). */
  talkDir: string
  title: string
  kind: CaptureKind
  prompt?: string
  /** Provenance, each as scout takes it: `scout:<passage id>`, `url:<address>` or `file:<path>`. */
  sources?: string[]
  /** A file to copy into `research/` beside the new Markdown file. */
  artefact?: string
  body: string
}

export type CaptureErrorCode = 'invalid-input' | 'outside-vault' | 'talk-folder-missing' | 'not-a-talk' | 'scout-missing' | 'capture-failed'

export type CaptureError = {
  code: CaptureErrorCode
  /** Plain words for the sheet. */
  message: string
  /** Raw detail (scout's stderr). Logged in main, never rendered. */
  detail?: string
}

export type CaptureResult =
  | { ok: true; file: string; corpus: string | null; indexed: boolean }
  | { ok: false; error: CaptureError }

export interface CaptureDeps {
  /** The vault the talk must sit inside; null when no vault is open. */
  vaultRoot: string | null
  env?: NodeJS.ProcessEnv
  home?: string
  platform?: NodeJS.Platform
  timeoutMs?: number
  /** Where `detail` goes (the main-process log). */
  log?: (message: string) => void
}

const fail = (code: CaptureErrorCode, message: string, detail?: string): { ok: false; error: CaptureError } =>
  ({ ok: false, error: detail ? { code, message, detail } : { code, message } })

/** The first executable `scout` on PATH, else ~/.cargo/bin/scout, else null. */
export function findScout(env: NodeJS.ProcessEnv = process.env, home: string = homedir(), platform: NodeJS.Platform = process.platform): string | null {
  const names = platform === 'win32' ? ['scout.exe', 'scout.cmd', 'scout'] : ['scout']
  const folders = [...(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean), join(home, '.cargo', 'bin')]
  for (const folder of folders) {
    for (const name of names) {
      const candidate = join(folder, name)
      try {
        if (!statSync(candidate).isFile()) continue
        accessSync(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK)
        return candidate
      } catch { /* not here */ }
    }
  }
  return null
}

function isFolder(path: string): boolean {
  try { return statSync(path).isDirectory() } catch { return false }
}

function hasOutline(dir: string): boolean {
  try { return pickOutlineEntry(readdirSync(dir, { withFileTypes: true }), basename(dir)) !== null } catch { return false }
}

type Checked<T> = { ok: true; path: T } | { ok: false; result: { ok: false; error: CaptureError } }

/** The talk folder as a canonical real path, when it is an absolute path to a talk inside the vault; else the refusal. */
function talkFolderInside(vaultRoot: string | null, talkDir: unknown): Checked<string> {
  if (typeof talkDir !== 'string' || !talkDir || talkDir.includes('\0')) return { ok: false, result: fail('invalid-input', 'No talk folder was given.') }
  if (!isAbsolute(talkDir)) return { ok: false, result: fail('invalid-input', 'The talk folder must be given as a full path.') }
  if (!vaultRoot) return { ok: false, result: fail('outside-vault', 'Open a vault first: research is filed beside a talk in your vault.') }
  const inside = pathStaysInside(vaultRoot, talkDir)
  if (inside === null) return { ok: false, result: fail('outside-vault', 'That folder is not inside your vault, so nothing was filed.') }
  if (!isFolder(inside)) return { ok: false, result: fail('talk-folder-missing', 'The talk folder is not there any more, so nothing was filed.') }
  const real = inside // pathStaysInside returned the canonical real path
  // `<vault>/research/…` (any case) holds captured research, never a talk, even when it holds an outline.
  let canonicalRoot: string
  try { canonicalRoot = realpathSync(vaultRoot) } catch { return { ok: false, result: fail('outside-vault', 'That folder is not inside your vault, so nothing was filed.') } }
  if (inReservedFolder(canonicalRoot, real)) return { ok: false, result: fail('not-a-talk', 'This folder is not a talk.') }
  if (!hasOutline(real)) return { ok: false, result: fail('not-a-talk', 'This folder is not a talk.') }
  return { ok: true, path: real }
}

/** An artefact file the renderer or agent names: it must be an existing file inside the vault. Returns its canonical path. */
function artefactInside(vaultRoot: string, artefact: string): Checked<string> {
  const refuse = (): Checked<string> => ({ ok: false, result: fail('outside-vault', 'The attached file is not inside your vault, so nothing was filed.') })
  if (!isAbsolute(artefact)) return refuse()
  const inside = pathStaysInside(vaultRoot, artefact)
  if (inside === null) return refuse()
  try {
    if (!statSync(inside).isFile()) return refuse()
    return { ok: true, path: realpathSync(inside) }
  } catch { return refuse() }
}

/** The argv after the binary name; the body goes on stdin (`-`). Values use `--flag=value` so a title that starts with a dash is still a value. */
export function captureArgs(input: CaptureInput): string[] {
  const args = ['capture', `--project=${input.talkDir}`, `--kind=${input.kind}`, `--title=${input.title}`]
  if (input.prompt) args.push(`--prompt=${input.prompt}`)
  for (const source of input.sources ?? []) args.push(`--source=${source}`)
  if (input.artefact) args.push(`--artefact=${input.artefact}`)
  args.push('--by=app:talkweaver', '--json', '-')
  return args
}

const noNul = (value: string): boolean => !value.includes('\0')

/** The input's shape, checked before anything else touches it (it arrives over IPC or from the agent). */
function checkInput(input: unknown): { ok: true; value: CaptureInput } | { ok: false; result: { ok: false; error: CaptureError } } {
  const bad = (message: string) => ({ ok: false as const, result: fail('invalid-input', message) })
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return bad('The capture request was not understood.')
  const o = input as Record<string, unknown>
  for (const key of ['talkDir', 'title', 'kind', 'body'] as const) {
    if (typeof o[key] !== 'string') return bad(key === 'title' ? 'Give the capture a title.' : key === 'body' ? 'There is no text to file.' : `The capture request is missing ${key}.`)
  }
  for (const key of ['prompt', 'artefact'] as const) {
    if (o[key] !== undefined && typeof o[key] !== 'string') return bad(`The ${key} must be text.`)
  }
  if (o.sources !== undefined && (!Array.isArray(o.sources) || o.sources.some((s) => typeof s !== 'string'))) return bad('Sources must be a list of text.')
  const strings = [o.talkDir, o.title, o.kind, o.body, o.prompt, o.artefact, ...(Array.isArray(o.sources) ? o.sources : [])]
  if (strings.some((s) => typeof s === 'string' && !noNul(s))) return bad('The capture contains a character that cannot be filed.')
  if (!(o.title as string).trim()) return bad('Give the capture a title.')
  if (!(CAPTURE_KINDS as readonly string[]).includes(o.kind as string)) return bad(`Kind must be one of ${CAPTURE_KINDS.join(', ')}.`)
  return { ok: true, value: o as unknown as CaptureInput }
}

function parseReply(stdout: string): { file: string; corpus: string | null; indexed: boolean } | null {
  try {
    const reply = JSON.parse(stdout) as Record<string, unknown>
    if (typeof reply.file !== 'string' || !reply.file) return null
    return { file: reply.file, corpus: typeof reply.corpus === 'string' ? reply.corpus : null, indexed: reply.indexed === true }
  } catch { return null }
}

/**
 * The result as the renderer and the agent get it: `code` and `message` only on a failure. scout's raw
 * words (`detail`) are logged by captureResearch through deps.log and never returned. The IPC handler
 * and the agent verb both apply this one function.
 */
export function withoutDetail(result: CaptureResult): CaptureResult {
  return result.ok ? result : { ok: false, error: { code: result.error.code, message: result.error.message } }
}

export function captureResearch(raw: unknown, deps: CaptureDeps): Promise<CaptureResult> {
  const checked = checkInput(raw)
  if (!checked.ok) return Promise.resolve(checked.result)
  const input = checked.value
  const folder = talkFolderInside(deps.vaultRoot, input.talkDir)
  if (!folder.ok) return Promise.resolve(folder.result)
  const clean: CaptureInput = { ...input, title: input.title.trim(), talkDir: folder.path, prompt: input.prompt?.trim() || undefined }
  if (input.artefact) {
    const artefact = artefactInside(deps.vaultRoot as string, input.artefact)
    if (!artefact.ok) return Promise.resolve(artefact.result)
    clean.artefact = artefact.path
  }
  const scout = findScout(deps.env, deps.home, deps.platform)
  if (!scout) return Promise.resolve(fail('scout-missing', 'Scout is not installed on this computer, so nothing was filed. Install scout, then try again.'))
  const log = deps.log ?? ((message: string) => console.error(message))
  return new Promise((resolve) => {
    const child = execFile(scout, captureArgs(clean), {
      env: deps.env ?? process.env,
      timeout: deps.timeoutMs ?? 30_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8'
    }, (error, stdout, stderr) => {
      if (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolve(fail('scout-missing', 'Scout is not installed on this computer, so nothing was filed. Install scout, then try again.'))
        const detail = String(stderr || '').trim().split('\n').filter(Boolean).slice(-2).join(' ') || String(error.message)
        log(`[research-capture] scout failed: ${detail}`)
        return resolve(fail('capture-failed', 'Scout could not file this. The research folder may not be writable.', detail))
      }
      const reply = parseReply(String(stdout))
      resolve(reply ? { ok: true, ...reply } : fail('capture-failed', 'Scout answered, but not in a form TalkWeaver can read, so the capture may not have been filed.', String(stdout).slice(0, 300)))
    })
    // A scout that exits before reading the body closes the pipe; that surfaces through the callback above.
    child.stdin?.on('error', () => { /* handled by the exit status */ })
    child.stdin?.end(clean.body)
  })
}

export type RevealResult = { ok: true; path: string } | { ok: false; error: CaptureError }

/** Create `<talk folder>/research/` when absent and hand it to `reveal` (Finder). */
export function revealResearchFolder(talkDir: unknown, deps: { vaultRoot: string | null; reveal: (path: string) => void }): RevealResult {
  const folder = talkFolderInside(deps.vaultRoot, talkDir)
  if (!folder.ok) return folder.result
  const research = join(folder.path, 'research')
  const refuse = (): RevealResult => fail('outside-vault', 'The research folder is not an ordinary folder inside your vault, so it was not opened.')
  let existing: ReturnType<typeof lstatSync> | null = null
  try { existing = lstatSync(research) } catch { /* absent */ }
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) return refuse()
    // The talk path is already canonical, so judge it against the vault's canonical root.
    let realRoot: string
    try { realRoot = realpathSync(deps.vaultRoot as string) } catch { return refuse() }
    if (pathStaysInside(realRoot, research) === null) return refuse()
  } else {
    try { mkdirSync(research) } catch {
      return fail('capture-failed', 'The research folder could not be created.')
    }
  }
  deps.reveal(research)
  return { ok: true, path: research }
}
