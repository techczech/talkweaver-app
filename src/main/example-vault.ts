/**
 * Open example vault (onboarding ticket 06; lock decision 2): five talks written from the app's own
 * bundle to `~/Documents/TalkWeaver/Example vault` when the person clicks Open example vault, then
 * added to the vault list as the vault flagged as the example. The only code in the app that
 * creates folders in the person's Documents folder.
 *
 * WRITTEN LIMITS. This module creates `TalkWeaver` (when it is not there), `Example vault`, the talk
 * folders and files from the bundle, and `.talkweaver/vault.json`, each only if nothing is there. It
 * never deletes, renames, overwrites or writes into a folder it did not just create. Node has no
 * `openat`, so the files are created by path: before each create, every folder from Documents down
 * is checked to be the same folder (device and inode) it was when made or first seen, and after each
 * create the path is checked to name the file just written. Another program running as the person
 * that swaps a folder for a symlink in the instant between that check and the create can still
 * redirect one create (never an overwrite: every create is exclusive). The same check-then-act gap
 * is accepted in WriteFlex's example collection.
 *
 * ACCEPTED LIMITS (review round 1, 2026-10-09). Both need a program running with the person's own
 * permissions that wins a race of microseconds; closing them needs native directory handles.
 * - The chain is checked immediately before each of the two first mkdirs (TalkWeaver, Example vault)
 *   and after them, but a folder swapped for a link between that check and the mkdir can still
 *   redirect that one mkdir (an empty folder made elsewhere; nothing written into it, the next check
 *   refuses).
 * - Example vault replaced by an existing folder between its mkdir and the identity read that
 *   follows is taken as the folder made; the per-create checks then hold to that folder.
 *
 * The rules, each a test in `scripts/test-example-vault.mjs`:
 *
 * A. THE PATH IS FIXED: `<home>/Documents/TalkWeaver/Example vault`, from the injected home (its real
 *    path), on every call. No path comes from the renderer, and none is stored apart from the vault
 *    list's own entry.
 * B. NO SYMLINKS, NO STRANGERS. `Documents`, `TalkWeaver` and `Example vault` must each be a plain
 *    folder, not a symlink, where they exist. Documents must exist (it is never created). A symlink
 *    anywhere on the path refuses; a file or a folder that is not the example vault at the path is
 *    left alone and named in one sentence. Nothing is written in either case.
 * C. A FOLDER ALREADY AT THE PATH. When the list holds a vault at the fixed path flagged as the
 *    example, it is opened again (if closed): nothing written. When the list holds a vault of the
 *    person's own there, it is in the way. When the list holds nothing there, the folder is added as
 *    the example only if it holds `.talkweaver/vault.json` (a plain file in a plain folder, at most
 *    1 MB) that parses as a vault file with `"example": true` — the recovery for a write whose last
 *    step, adding to the list, failed; nothing is written. Anything else at the path is in the way.
 * D. THE LIST IS ASKED FIRST. Before anything is created, the vault list's own rules are checked for
 *    the fixed path (roots never nest, no duplicates); a refusal there writes nothing.
 * E. THE BUNDLE IS READ WHOLE FIRST, bounded (`BUNDLE_LIMITS`): only plain folders and files, safe
 *    names, no `.talkweaver` (the vault file is made here, with a fresh id), the start talk present.
 *    A bundle that breaks a limit writes nothing.
 * F. EXCLUSIVE, IN ORDER, MARKER LAST. `TalkWeaver` (if missing), then `Example vault` with an
 *    exclusive mkdir (anything already there: in the way, nothing written), then the bundle's folders
 *    and files (exclusive create, fsync), then `.talkweaver/vault.json` last. The vault file is the
 *    commit mark: a write that stops part-way leaves a folder without it, which a later click treats
 *    as in the way (refused, with the sentence) and never writes into. Nothing is cleaned up.
 * G. THEN THE LIST. The folder is added with `example: true`. If that fails, the folder stays, and
 *    the next click adopts it by rule C.
 * H. ONE AT A TIME. Calls run in the order they were made.
 *
 * FAILS QUIET: `open()` never throws; every outcome is a result with one sentence, and the log gets
 * an outcome and an error code, never a path or file contents.
 * TESTS NEVER TOUCH THE REAL HOME: the home folder, the bundle and the vault list are injected.
 */
import { randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { constants as fsConstants } from 'node:fs'
import { lstat, mkdir, open as openFile, opendir, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep, isAbsolute } from 'node:path'
import { parseVaultFile, VAULT_FILE_DIR, VAULT_FILE_MAX_BYTES, VAULT_FILE_NAME, VAULT_FILE_SCHEMA, vaultFileBytes, type VaultFile } from './vault-file.ts'
import { VaultRefusal, type Vault, type VaultRegistry } from './vault-registry.ts'
import { refusalMessage } from './vault-view.ts'
import { EXAMPLE_VAULT_TEXT, type ExampleVaultResult } from '../shared/example-vault.ts'

export const EXAMPLE_DOCUMENTS_NAME = 'Documents'
export const EXAMPLE_PARENT_NAME = 'TalkWeaver'
export const EXAMPLE_FOLDER_NAME = 'Example vault'
/** The start talk, vault-relative ('/'-separated): The Saturday market. */
export const EXAMPLE_START_TALK = 'the-saturday-market/the-saturday-market-outline.md'
/** The bundle's limits (rule E). Ticket 09's full talks fit with room to spare. */
export const BUNDLE_LIMITS = { entries: 400, depth: 6, fileBytes: 8 * 1024 * 1024, totalBytes: 48 * 1024 * 1024 } as const

/** The harness override for the home folder. See `resolveExampleHome`. */
export const EXAMPLE_HOME_OVERRIDE = 'TW_E2E_HOME'

export const EXAMPLE_VAULT_MESSAGES = {
  unavailable: 'The example vault cannot be written in this session.',
  inTheWay: 'A folder named “Example vault” is already in Documents › TalkWeaver, so the example vault was not written. Move or rename that folder, then try again.',
  parentInTheWay: 'Something named “TalkWeaver” in Documents is not a folder, so the example vault was not written.',
  noDocuments: 'There is no Documents folder in your home folder, so the example vault was not written.',
  symlink: 'Part of the path to Documents › TalkWeaver › Example vault is a link to somewhere else, so the example vault was not written.',
  failed: 'The example vault could not be written. Anything already written is left in Documents › TalkWeaver › Example vault.',
  bundle: 'The example vault is missing from this copy of TalkWeaver, so nothing was written.',
  notListed: 'The example vault was written to Documents › TalkWeaver, but TalkWeaver could not add it to your vaults. Try again to add it.',
} as const

/**
 * The home folder for this run, or null for "write nothing". A run with the e2e flag never sees the
 * real home: it gets `TW_E2E_HOME`, honoured only when the app is unpackaged, `TW_E2E` is `1`, and
 * the folder's real path is inside the real system temp folder; otherwise null. A normal launch
 * uses the system's home folder.
 */
export function resolveExampleHome(input: {
  isPackaged: boolean
  env: Record<string, string | undefined>
  systemHome: () => string
  realpath?: (path: string) => string
  systemTemp?: () => string
}): string | null {
  if (input.env.TW_E2E !== '1') return input.systemHome()
  if (input.isPackaged) return null
  const override = input.env[EXAMPLE_HOME_OVERRIDE]?.trim() ?? ''
  if (!override || !isAbsolute(override)) return null
  try {
    const real = (input.realpath ?? ((p: string) => p))(override)
    const temp = (input.realpath ?? ((p: string) => p))((input.systemTemp ?? tmpdir)())
    const rel = relative(temp, real)
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? real : null
  } catch {
    return null
  }
}

export type ExampleVaultDirEntry = { name: string; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }
/** An open, read-only file: the descriptor's own stat, positional reads, close. */
export type ExampleVaultReadHandle = {
  stat: () => Promise<Stats>
  read: (buffer: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number }>
  close: () => Promise<void>
}

/** Everything this module does to the disk. There is no remove, rename or overwrite to call. */
export type ExampleVaultFs = {
  lstat: (path: string) => Promise<Stats>
  realpath: (path: string) => Promise<string>
  /** A directory's entries, one at a time (the reader stops at the bundle's cap). */
  opendir: (path: string) => Promise<AsyncIterable<ExampleVaultDirEntry>>
  /** Open an existing file O_RDONLY | O_NOFOLLOW (a link fails). */
  openRead: (path: string) => Promise<ExampleVaultReadHandle>
  readFile: (path: string) => Promise<Buffer>
  /** Create ONE directory. Fails with EEXIST if anything of that name exists. Never recursive. */
  mkdir: (path: string) => Promise<void>
  /** Create a file that does not exist (O_CREAT | O_EXCL | O_NOFOLLOW), write it whole, fsync it,
   *  and answer the created file's device and inode. Never opens an existing file. */
  createFile: (path: string, data: Buffer) => Promise<{ dev: number; ino: number }>
}

export const nodeExampleVaultFs: ExampleVaultFs = {
  lstat: (path) => lstat(path),
  realpath: (path) => realpath(path),
  opendir: (path) => opendir(path),
  openRead: async (path) => {
    const handle = await openFile(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    return {
      stat: () => handle.stat(),
      read: async (buffer, offset, length, position) => ({ bytesRead: (await handle.read(buffer, offset, length, position)).bytesRead }),
      close: () => handle.close(),
    }
  },
  readFile: (path) => readFile(path),
  mkdir: async (path) => { await mkdir(path) },
  createFile: async (path, data) => {
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0)
    const handle = await openFile(path, flags, 0o644)
    try {
      await handle.writeFile(data)
      await handle.sync()
      const st = await handle.stat()
      return { dev: st.dev, ino: st.ino }
    } finally {
      await handle.close()
    }
  },
}

export type ExampleVaultDeps = {
  /** The one source of the home folder; null means this run writes nothing. */
  home: () => string | null
  /** The folder holding the bundled talks (the app's own resources). */
  bundleDir: string
  registry: VaultRegistry
  newId?: () => string
  now?: () => Date
  /** One line per outcome. Never given paths or file contents. */
  log?: (event: string, details: Record<string, unknown>) => void
  fs?: ExampleVaultFs
}

type BundleEntry = { rel: string[]; kind: 'dir' } | { rel: string[]; kind: 'file'; data: Buffer }
type Identity = { path: string; dev: number; ino: number }

class Stop extends Error {
  readonly result: Extract<ExampleVaultResult, { ok: false }>
  readonly code: string
  constructor(result: Extract<ExampleVaultResult, { ok: false }>, code?: string) {
    super(result.message)
    this.result = result
    this.code = code ?? result.reason
  }
}
const stop = (reason: Extract<ExampleVaultResult, { ok: false }>['reason'], message: string, code?: string): never => {
  throw new Stop({ ok: false, reason, message }, code)
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'UNKNOWN'
}

const SAFE_NAME = /^[^/\\\0:]{1,120}$/
const isSafeName = (name: string): boolean => SAFE_NAME.test(name) && name !== '.' && name !== '..' && name.trim() === name

const norm = (p: string): string => {
  const r = resolve(p)
  return r.length > 1 && r.endsWith(sep) ? r.slice(0, -1) : r
}

export class ExampleVault {
  readonly #deps: ExampleVaultDeps
  readonly #fs: ExampleVaultFs
  #queue: Promise<unknown> = Promise.resolve()

  constructor(deps: ExampleVaultDeps) {
    this.#deps = deps
    this.#fs = deps.fs ?? nodeExampleVaultFs
  }

  /** The fixed path for this run (rule A), or null when there is no home. Reads the disk once. */
  async root(): Promise<string | null> {
    const home = this.#deps.home()
    if (!home) return null
    const realHome = await this.#fs.realpath(home).catch(() => resolve(home))
    return join(realHome, EXAMPLE_DOCUMENTS_NAME, EXAMPLE_PARENT_NAME, EXAMPLE_FOLDER_NAME)
  }

  /** Open example vault. Never throws. Calls run one at a time (rule H). */
  open(): Promise<ExampleVaultResult> {
    const run = this.#queue.then(() => this.#open())
    this.#queue = run.catch(() => undefined)
    return run
  }

  async #open(): Promise<ExampleVaultResult> {
    try {
      const result = await this.#run()
      this.#log(result.outcome)
      return result
    } catch (error) {
      if (error instanceof Stop) {
        this.#log(error.result.reason, error.code)
        return error.result
      }
      this.#log('failed', errorCode(error))
      return { ok: false, reason: 'failed', message: EXAMPLE_VAULT_MESSAGES.failed }
    }
  }

  #log(outcome: string, code?: string): void {
    try {
      this.#deps.log?.('example-vault.open', { outcome, ...(code && code !== outcome ? { code } : {}) })
    } catch { /* logging never breaks the click */ }
  }

  async #lstatOrNull(path: string): Promise<Stats | null> {
    try {
      return await this.#fs.lstat(path)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null
      throw error
    }
  }

  async #run(): Promise<Extract<ExampleVaultResult, { ok: true }>> {
    const home = this.#deps.home()
    if (!home) stop('unavailable', EXAMPLE_VAULT_MESSAGES.unavailable)
    // Rule A: the home's real path (a home reached through a link is still the person's home).
    const realHome = await this.#fs.realpath(home as string).catch(() => stop('unavailable', EXAMPLE_VAULT_MESSAGES.unavailable, 'NO_HOME'))
    const documents = join(realHome, EXAMPLE_DOCUMENTS_NAME)
    const parent = join(documents, EXAMPLE_PARENT_NAME)
    const root = join(parent, EXAMPLE_FOLDER_NAME)

    // Rule B: Documents is a plain folder; it is never created.
    const docStat = await this.#lstatOrNull(documents)
    if (!docStat) stop('refused', EXAMPLE_VAULT_MESSAGES.noDocuments, 'NO_DOCUMENTS')
    if (docStat!.isSymbolicLink()) stop('refused', EXAMPLE_VAULT_MESSAGES.symlink, 'DOCUMENTS_SYMLINK')
    if (!docStat!.isDirectory()) stop('refused', EXAMPLE_VAULT_MESSAGES.noDocuments, 'DOCUMENTS_NOT_DIR')
    const parentStat = await this.#lstatOrNull(parent)
    if (parentStat?.isSymbolicLink()) stop('refused', EXAMPLE_VAULT_MESSAGES.symlink, 'PARENT_SYMLINK')
    if (parentStat && !parentStat.isDirectory()) stop('in-the-way', EXAMPLE_VAULT_MESSAGES.parentInTheWay, 'PARENT_NOT_DIR')
    const rootStat = parentStat ? await this.#lstatOrNull(root) : null
    if (rootStat?.isSymbolicLink()) stop('refused', EXAMPLE_VAULT_MESSAGES.symlink, 'ROOT_SYMLINK')
    if (rootStat && !rootStat.isDirectory()) stop('in-the-way', EXAMPLE_VAULT_MESSAGES.inTheWay, 'ROOT_NOT_DIR')

    // Rule C: something is already there.
    if (rootStat) return this.#existing(root)

    // Rule D: the list's own rules, before anything is created.
    this.#checkList(root)

    // Rule E: the bundle, whole and bounded, before the person's disk is written.
    const bundle = await this.#readBundle()

    // Rule F: exclusive creates in order, the vault file last.
    // The chain from Documents down is checked again immediately before each of the two first mkdirs
    // (the bundle read above takes time) and after each (accepted limit in the header for the gap).
    const chain: Identity[] = [{ path: documents, dev: docStat!.dev, ino: docStat!.ino }]
    if (parentStat) {
      chain.push({ path: parent, dev: parentStat.dev, ino: parentStat.ino })
    } else {
      await this.#sameChain(chain)
      try {
        await this.#fs.mkdir(parent)
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error
      }
      chain.push(await this.#plainDir(parent, 'PARENT'))
    }
    await this.#sameChain(chain)
    try {
      await this.#fs.mkdir(root) // exclusive: anything already there is the person's
    } catch (error) {
      if (errorCode(error) === 'EEXIST') stop('in-the-way', EXAMPLE_VAULT_MESSAGES.inTheWay, 'ROOT_APPEARED')
      throw error
    }
    chain.push(await this.#plainDir(root, 'ROOT'))
    await this.#sameChain(chain)
    // The folder made is where it was meant to be: its real path is the fixed path.
    if (norm(await this.#fs.realpath(root)) !== norm(root)) stop('refused', EXAMPLE_VAULT_MESSAGES.symlink, 'ROOT_ELSEWHERE')

    const dirs = new Map<string, Identity>([['', chain[chain.length - 1]]])
    const write = async (rel: string[], kind: 'dir' | 'file', data?: Buffer): Promise<void> => {
      const parentKey = rel.slice(0, -1).join('/')
      const holder = dirs.get(parentKey)
      if (!holder) stop('failed', EXAMPLE_VAULT_MESSAGES.bundle, 'BUNDLE_ORDER')
      const target = join(root, ...rel)
      // Every folder from Documents down is still the one made or first seen: before the create, and
      // again after it, before the result is looked at.
      const holders = [...chain, ...this.#ancestorsOf(rel, dirs)]
      await this.#sameChain(holders)
      if (kind === 'dir') {
        await this.#fs.mkdir(target)
        await this.#sameChain(holders)
        dirs.set(rel.join('/'), await this.#plainDir(target, 'DIR'))
        return
      }
      const made = await this.#fs.createFile(target, data as Buffer)
      await this.#sameChain(holders)
      const now = await this.#fs.lstat(target)
      if (!now.isFile() || now.dev !== made.dev || now.ino !== made.ino) stop('failed', EXAMPLE_VAULT_MESSAGES.failed, 'FILE_MOVED')
    }
    for (const entry of bundle) await write(entry.rel, entry.kind, entry.kind === 'file' ? entry.data : undefined)

    // The vault file, last (the commit mark).
    const id = (this.#deps.newId ?? randomUUID)()
    const file: VaultFile = {
      schema: VAULT_FILE_SCHEMA,
      id,
      name: EXAMPLE_VAULT_TEXT.name,
      shared: false,
      example: true,
      created_by: 'TalkWeaver',
      created_at: (this.#deps.now ?? (() => new Date()))().toISOString(),
    }
    await write([VAULT_FILE_DIR], 'dir')
    await write([VAULT_FILE_DIR, VAULT_FILE_NAME], 'file', Buffer.from(vaultFileBytes(file), 'utf8'))

    // Rule G: then the list.
    const vault = this.#addToList(root)
    return { ok: true, vaultId: vault.id, outcome: 'written', startTalk: await this.#startTalk(root) }
  }

  /** Rule C: a folder at the fixed path. */
  async #existing(root: string): Promise<Extract<ExampleVaultResult, { ok: true }>> {
    const listed = this.#deps.registry.list().find((v) => norm(v.root) === norm(root)) ?? null
    if (listed) {
      // The list's own flag is the record that this path was added as the example; opening it again
      // writes nothing. A vault of the person's own at this path is in the way.
      if (listed.example !== true) stop('in-the-way', EXAMPLE_VAULT_MESSAGES.inTheWay, 'LISTED_NOT_EXAMPLE')
      if (!listed.open) {
        try {
          this.#deps.registry.setOpen(listed.id, true)
        } catch (error) {
          this.#listRefusal(error)
        }
      }
      return { ok: true, vaultId: listed.id, outcome: 'reopened', startTalk: await this.#startTalk(root) }
    }
    if (!(await this.#readMarker(root))) stop('in-the-way', EXAMPLE_VAULT_MESSAGES.inTheWay, 'FOREIGN')
    const vault = this.#addToList(root)
    return { ok: true, vaultId: vault.id, outcome: 'adopted', startTalk: await this.#startTalk(root) }
  }

  /** The example vault file at root, or null (rule C). Reads only; refuses links and oversize files. */
  async #readMarker(root: string): Promise<VaultFile | null> {
    const dir = join(root, VAULT_FILE_DIR)
    const path = join(dir, VAULT_FILE_NAME)
    const dirStat = await this.#lstatOrNull(dir).catch(() => null)
    if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory()) return null
    const st = await this.#lstatOrNull(path).catch(() => null)
    if (!st || st.isSymbolicLink() || !st.isFile() || st.size > VAULT_FILE_MAX_BYTES) return null
    let text: string
    try { text = (await this.#fs.readFile(path)).toString('utf8') } catch { return null }
    const read = parseVaultFile(text)
    return read.state === 'ok' && read.file.example === true ? read.file : null
  }

  #checkList(root: string): void {
    try {
      this.#deps.registry.probe(root)
    } catch (error) {
      this.#listRefusal(error)
    }
  }

  #listRefusal(error: unknown): never {
    if (error instanceof VaultRefusal) {
      const otherName = error.other ? error.other.root.split(/[\\/]+/).filter(Boolean).pop() ?? null : null
      if (error.reason === 'inside-another' || error.reason === 'contains-another' || error.reason === 'duplicate' || error.reason === 'duplicate-id') {
        return stop('nested', refusalMessage(error.reason, otherName), error.reason)
      }
      return stop('failed', refusalMessage(error.reason, otherName), error.reason)
    }
    throw error
  }

  #addToList(root: string): Vault {
    try {
      return this.#deps.registry.add(root, { example: true })
    } catch (error) {
      if (error instanceof VaultRefusal && (error.reason === 'config-unwritable' || error.reason === 'partial-write')) {
        return stop('failed', EXAMPLE_VAULT_MESSAGES.notListed, error.reason)
      }
      if (error instanceof VaultRefusal) return this.#listRefusal(error)
      return stop('failed', EXAMPLE_VAULT_MESSAGES.notListed, errorCode(error))
    }
  }

  async #startTalk(root: string): Promise<string | null> {
    const path = join(root, ...EXAMPLE_START_TALK.split('/'))
    const st = await this.#lstatOrNull(path).catch(() => null)
    return st?.isFile() ? path : null
  }

  async #plainDir(path: string, what: string): Promise<Identity> {
    const st = await this.#fs.lstat(path)
    if (st.isSymbolicLink()) stop('refused', EXAMPLE_VAULT_MESSAGES.symlink, `${what}_SYMLINK`)
    if (!st.isDirectory()) stop('in-the-way', what === 'PARENT' ? EXAMPLE_VAULT_MESSAGES.parentInTheWay : EXAMPLE_VAULT_MESSAGES.inTheWay, `${what}_NOT_DIR`)
    return { path, dev: st.dev, ino: st.ino }
  }

  async #sameChain(chain: Identity[]): Promise<void> {
    for (const link of chain) {
      const st = await this.#lstatOrNull(link.path)
      if (!st || st.isSymbolicLink() || !st.isDirectory() || st.dev !== link.dev || st.ino !== link.ino) {
        stop('refused', EXAMPLE_VAULT_MESSAGES.symlink, 'CHAIN_CHANGED')
      }
    }
  }

  #ancestorsOf(rel: string[], dirs: Map<string, Identity>): Identity[] {
    const out: Identity[] = []
    for (let i = 1; i < rel.length; i += 1) {
      const known = dirs.get(rel.slice(0, i).join('/'))
      if (known) out.push(known)
    }
    return out
  }

  /**
   * One bundle file, bounded: opened O_RDONLY | O_NOFOLLOW, the descriptor must be a plain file, the
   * one lstat saw, no larger than the allowance (the per-file cap or what is left of the total); at
   * most allowance + 1 bytes are read, and a file that has grown past the allowance fails.
   */
  async #readBounded(path: string, seen: Stats, totalLeft: number, fail: (code: string) => never): Promise<Buffer> {
    const allowance = Math.max(0, Math.min(BUNDLE_LIMITS.fileBytes, totalLeft))
    const overCode = totalLeft < BUNDLE_LIMITS.fileBytes ? 'BUNDLE_TOTAL_SIZE' : 'BUNDLE_FILE_SIZE'
    const handle = await this.#fs.openRead(path).catch(() => fail('BUNDLE_READ'))
    try {
      const st = await handle.stat().catch(() => fail('BUNDLE_READ'))
      if (!st.isFile() || st.dev !== seen.dev || st.ino !== seen.ino) fail('BUNDLE_CHANGED')
      if (st.size > allowance) fail(overCode)
      const chunks: Buffer[] = []
      let read = 0
      while (read <= allowance) {
        const want = Math.min(64 * 1024, allowance + 1 - read)
        const buf = Buffer.alloc(want)
        const { bytesRead } = await handle.read(buf, 0, want, read).catch(() => fail('BUNDLE_READ'))
        if (bytesRead <= 0) break
        chunks.push(bytesRead === want ? buf : buf.subarray(0, bytesRead))
        read += bytesRead
      }
      if (read > allowance) fail(overCode)
      return Buffer.concat(chunks, read)
    } finally {
      await handle.close().catch(() => undefined)
    }
  }

  /** Rule E: every folder and file under the bundle, parents before children, in name order. */
  async #readBundle(): Promise<BundleEntry[]> {
    const out: BundleEntry[] = []
    let total = 0
    const fail = (code: string): never => stop('failed', EXAMPLE_VAULT_MESSAGES.bundle, code)
    const walk = async (dir: string, rel: string[]): Promise<void> => {
      if (rel.length > BUNDLE_LIMITS.depth) fail('BUNDLE_DEPTH')
      // Entries are taken one at a time and the walk stops past the cap; a directory is never read whole.
      const names: string[] = []
      try {
        for await (const entry of await this.#fs.opendir(dir)) {
          if (entry.name === '.DS_Store') continue
          names.push(entry.name)
          if (out.length + names.length > BUNDLE_LIMITS.entries) fail('BUNDLE_ENTRIES')
        }
      } catch (error) {
        if (error instanceof Stop) throw error
        return fail(`BUNDLE_${errorCode(error)}`)
      }
      names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      for (const name of names) {
        if (!isSafeName(name)) fail('BUNDLE_NAME')
        if (rel.length === 0 && name === VAULT_FILE_DIR) fail('BUNDLE_VAULT_FILE')
        if (out.length >= BUNDLE_LIMITS.entries) fail('BUNDLE_ENTRIES')
        const path = join(dir, name)
        const st = await this.#fs.lstat(path).catch(() => fail('BUNDLE_STAT'))
        const here = [...rel, name]
        if (st.isSymbolicLink()) fail('BUNDLE_SYMLINK')
        if (st.isDirectory()) {
          out.push({ rel: here, kind: 'dir' })
          await walk(path, here)
        } else if (st.isFile()) {
          if (st.size > BUNDLE_LIMITS.fileBytes) fail('BUNDLE_FILE_SIZE')
          const data = await this.#readBounded(path, st, BUNDLE_LIMITS.totalBytes - total, fail)
          total += data.length
          out.push({ rel: here, kind: 'file', data })
        } else {
          fail('BUNDLE_SPECIAL')
        }
      }
    }
    await walk(this.#deps.bundleDir, [])
    if (!out.some((e) => e.kind === 'file' && e.rel.join('/') === EXAMPLE_START_TALK)) fail('BUNDLE_NO_START')
    return out
  }
}
