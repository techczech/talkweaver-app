/**
 * Removing the example vault and bringing it back (onboarding 0.38.1 ticket 12; lock decisions 14
 * and 17). The writer is `example-vault.ts` (ticket 06) and is not changed by anything here; this
 * module is the only code in the app that moves a folder in the person's Documents to the Bin.
 * Its rules follow WriteFlex's reviewed `example-removal.ts`, applied to a registered vault.
 *
 * WRITTEN LIMITS. Between the last checks below and the move to the Bin there is a gap in which
 * another program, running with the person's own permissions, could swap what is at the path; the
 * trash function is then given the same fixed path. If the LAST part (`Example vault`) has become a
 * symlink, the link itself is moved and what it points to stays. If an EARLIER part (`TalkWeaver`,
 * `Documents`) has become a symlink, the trash follows it, and whatever folder named `Example vault`
 * is at the far end goes to the Bin. Node has no handle-based trash, so nothing here narrows that gap;
 * it is the same accepted limit as WriteFlex's and ticket 06's.
 *
 * Open windows: removal never closes a window. While any window shows, or might show, an example
 * talk, the preview gives no token and Remove does nothing; the person closes those windows first
 * (rule I). Nothing unsaved can then be binned, because nothing that could hold it is open.
 *
 * The rules, each a test in `scripts/test-example-vault-removal.mjs`:
 *
 * A. THE PATH IS FIXED: `<home>/Documents/TalkWeaver/Example vault`, from the injected home's real
 *    path, on every call. Nothing path-like is an argument of any method here; `remove` takes the
 *    confirmation's token (64 hexadecimal characters, never used as a path) and main's own number for
 *    the asking window.
 * B. ONE DESTRUCTIVE CALL. `remove()` calls the injected trash function at most once, with exactly
 *    the fixed path. This module's filesystem port is lstat, realpath, opendir and readFile: there is
 *    no delete, rename or overwrite to call.
 * C. ONLY THE REGISTERED, MARKED EXAMPLE. Removal acts only while the vault list holds a vault flagged
 *    as the example whose root is the fixed path, and the folder there holds the example vault file
 *    (`.talkweaver/vault.json`, a plain file, `"example": true`, the same id as the list's entry).
 *    Anything else is the person's and is refused in one sentence.
 * D. CHECKED BEFORE IT IS MOVED. `Documents`, `TalkWeaver` and `Example vault` must each be a plain
 *    folder (lstat: not a symlink), each resolving directly inside the one above, up to the home's real
 *    path. A folder holding more than `EXAMPLE_COUNT_LIMIT` entries is not the example.
 * E. ORDER. The token; the checks of C and D and the fresh count against the confirmation; the open
 *    windows (rule I), asked with no wait between that answer and the trash call; then the trash. Only
 *    when it has succeeded AND the path is then empty: the vault leaves the list (the registry's own
 *    `remove`) and the removed record is set. If the trash fails, the list and the record are
 *    unchanged. If the folder is already gone (binned in Finder): the vault leaves the list, the record
 *    is set, and no trash call is made.
 * F. RESTORE goes through ticket 06's writer (`ExampleVault.open`), which writes a fresh copy by its
 *    exclusive rule, adopts a folder at the path only when it holds the example vault file, and
 *    otherwise says a folder of that name is in the way and changes nothing. On success the removed
 *    record is cleared. Progress (ticks, read marks, chapter opens) is never read or written here.
 * G. ONE AT A TIME. Calls run in the order they were made.
 * H. MAIN HOLDS THE CONFIRMATION. `preview()` makes a random single-use token kept with the window it
 *    was shown in, the vault's id, the folder's identity (device and inode), the counts shown and the
 *    time. `remove(token)` changes nothing and asks the person to look again unless the token is the
 *    live one, from that same window, younger than five minutes, and the folder is the same one with
 *    the same count. Any call to `remove` uses the token up; a new `preview` replaces it.
 * I. NO WINDOW ON THE EXAMPLE. The injected `openWindows(root)` names every window that shows, or
 *    might show, an example talk (main's own window bookkeeping; a window main cannot tie to a talk
 *    counts). If it names any, `preview` gives no token and `remove` changes nothing (its token is used
 *    up all the same); one sentence lists them. Nothing here closes a window.
 *
 * FAILS QUIET: no method throws. The log gets an outcome and an error code, never a path.
 * TESTS NEVER TOUCH THE REAL HOME OR THE REAL BIN: home, trash, windows and list are injected. The
 * e2e stand-in Bin is `example-trash-harness.ts`, reachable only in an unpackaged harness run.
 */
import { randomBytes } from 'node:crypto'
import type { Stats } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { parseVaultFile, VAULT_FILE_DIR, VAULT_FILE_MAX_BYTES, VAULT_FILE_NAME } from './vault-file.ts'
import type { Vault } from './vault-registry.ts'
import { EXAMPLE_DOCUMENTS_NAME, EXAMPLE_FOLDER_NAME, EXAMPLE_PARENT_NAME, nodeExampleVaultFs, type ExampleVaultFs } from './example-vault.ts'
import type { ExampleVaultResult } from '../shared/example-vault.ts'
import type { ExampleRemovalPreview, ExampleRemoveResult, ExampleRestoreResult } from '../shared/example-vault-removal.ts'

/** Reads only. No mkdir, create, rename or delete is reachable through this port. */
export type ExampleRemovalFs = Pick<ExampleVaultFs, 'lstat' | 'realpath' | 'opendir' | 'readFile'>

/** Moves one path to the Bin, or rejects. `shell.trashItem` in production. */
export type TrashItem = (path: string) => Promise<void>

/**
 * Rule I: an open window as main knows it. `editor`, `deck` and `pathways` are tied to a talk by main's
 * own bookkeeping; `tools` (Studio, History, Turn into text, Importer) and `other` (a window opened
 * from a deck window: the Presenter from a presentation, the Audience, a board) are not.
 */
export type OpenAppWindow =
  | { kind: 'editor' | 'deck' | 'pathways'; outlinePath: string | null; title: string }
  | { kind: 'tools'; title: string }
  | { kind: 'other'; /** The page's address. */ url: string; title: string }

export type ExampleRemovalDeps = {
  /** The one source of the home folder; null means this run removes nothing. */
  home: () => string | null
  /** The vault list: read, and the one way off it. */
  registry: { list(): Vault[]; remove(id: string): void }
  /** The removed record in app config (beside the list, outside every vault). */
  record: { removed(): boolean; setRemoved(removed: boolean): boolean }
  /** Ticket 06's writer: restore is its open. */
  writer: { open(): Promise<ExampleVaultResult> }
  /** THE destructive call. Given the fixed path and nothing else. */
  trash: TrashItem
  /** Rule I: the names of every window showing, or that might show, an example talk; none means none. */
  openWindows: (root: string) => string[]
  log?: (event: string, details: Record<string, unknown>) => void
  fs?: ExampleRemovalFs
  now?: () => number
}

/** The folder as the confirmation names it. Rule D has checked that the fixed path is a plain folder in place. */
export const EXAMPLE_DISPLAY_PATH = `~/${EXAMPLE_DOCUMENTS_NAME}/${EXAMPLE_PARENT_NAME}/${EXAMPLE_FOLDER_NAME}`

export const EXAMPLE_CONFIRMATION_MS = 5 * 60 * 1000
export const EXAMPLE_COUNT_LIMIT = 10_000
/** Rule I's sentence names at most this many windows, then "and N more". */
export const EXAMPLE_WINDOWS_NAMED = 3

/** Every sentence this module can show. One sentence each. */
export const EXAMPLE_REMOVAL_MESSAGES = {
  lookAgain: 'The example vault may have changed since you were shown it, so nothing was removed; please look again.',
  notListed: 'The example vault is not in your vaults, so there is nothing to remove.',
  noHome: 'TalkWeaver could not find your Documents folder, so nothing was removed.',
  notPlain: 'The folder at Documents › TalkWeaver › Example vault is not a plain folder inside Documents, so TalkWeaver left it where it is.',
  notExample: 'The folder at Documents › TalkWeaver › Example vault is not the example vault TalkWeaver wrote, so TalkWeaver left it where it is.',
  tooMany: `The folder at Documents › TalkWeaver › Example vault holds more than ${EXAMPLE_COUNT_LIMIT.toLocaleString('en-GB')} files, so it is not the example vault and nothing was removed.`,
  trashFailed: 'The example vault could not be moved to the Bin, so nothing was changed.',
  notRecorded: 'The example vault is in the Bin, but TalkWeaver could not take it off your vaults.',
  restoreFailed: 'The example vault could not be brought back.',
  windowsUnknown: 'TalkWeaver could not tell which windows show the example talks, so nothing was removed.',
} as const

/** Rule I's one sentence: "Close the example talks first: The Saturday market, Lightning round." */
export function closeExampleTalksFirst(names: readonly string[]): string {
  const shown = names.slice(0, EXAMPLE_WINDOWS_NAMED)
  const more = names.length - shown.length
  return `Close the example talks first: ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}.`
}

/**
 * Rule I: the names of the windows that show, or might show, an example talk, each name once.
 * `inExample` says whether a path is inside the example vault. An editor, deck or Pathways window
 * counts when its talk is inside it. A Tools window counts whenever it is open (it is not tied to a
 * talk, and Turn into text, Studio and History can show one). Any other window counts unless its page
 * is a file outside the example vault and outside `tempDir` (a deck page is written beside its talk,
 * or in the temp folder when the talk's folder cannot be written); a page that is not a file (a
 * board) counts.
 */
export function windowsOnExample(windows: readonly OpenAppWindow[], inExample: (path: string) => boolean, tempDir: string, filePathOf: (url: string) => string | null): string[] {
  const names: string[] = []
  const add = (name: string): void => { const n = name.trim() || 'A presentation window'; if (!names.includes(n)) names.push(n) }
  const inTemp = (path: string): boolean => { const t = norm(tempDir); const p = norm(path); return p === t || p.startsWith(t + sep) }
  for (const w of windows) {
    try {
      if (w.kind === 'tools') add(w.title || 'TalkWeaver Tools')
      else if (w.kind === 'other') {
        const path = filePathOf(w.url)
        if (path === null || inExample(path) || inTemp(path)) add(w.title)
      } else if (w.outlinePath && inExample(w.outlinePath)) add(w.title)
    } catch {
      add(w.title) // a window that cannot be placed counts
    }
  }
  return names
}

type Located =
  | { kind: 'present'; root: string; st: Stats }
  | { kind: 'gone'; root: string }
  | { kind: 'refused' }
  | { kind: 'no-home' }

type Counted = { entries: number; talks: number; capped: boolean }

type Confirmation = {
  token: string
  sender: number
  vaultId: string
  present: boolean
  dev: number
  ino: number
  entries: number
  talks: number
  at: number
}

const TOKEN_SHAPE = /^[0-9a-f]{64}$/
/** TalkWeaver's own records directly inside a vault: outlines in them are not talks. */
const TALKWEAVER_RECORD_DIRS: ReadonlySet<string> = new Set([VAULT_FILE_DIR, '_SLIDE-VERSIONS'])
const NOTHING: Counted = { entries: 0, talks: 0, capped: false }

const norm = (p: string): string => {
  const r = resolve(p)
  return r.length > 1 && r.endsWith(sep) ? r.slice(0, -1) : r
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'UNKNOWN'
}

type Refusal = { ok: false; message: string }
const refuse = (message: string): Refusal => ({ ok: false, message })

export class ExampleVaultRemoval {
  readonly #deps: ExampleRemovalDeps
  readonly #fs: ExampleRemovalFs
  #confirmation: Confirmation | null = null
  #queue: Promise<unknown> = Promise.resolve()

  constructor(deps: ExampleRemovalDeps) {
    this.#deps = deps
    this.#fs = deps.fs ?? nodeExampleVaultFs
  }

  /** Settings → Get started: the person removed it, and it is not in the list now. No disk read. */
  wasRemoved(): boolean {
    try {
      return this.#deps.record.removed() && !this.#deps.registry.list().some((v) => v.example === true)
    } catch {
      return false
    }
  }

  /** What the confirmation shows, and the token Remove must give back (rule H). Reads only. */
  async preview(sender: number): Promise<ExampleRemovalPreview> {
    this.#confirmation = null // a new look replaces the last one
    try {
      const listed = await this.#listed()
      if (!listed) return refuse(EXAMPLE_REMOVAL_MESSAGES.notListed)
      const at = await this.#examine(listed.vault)
      if (!at.ok) return at
      if (at.counted.capped) return refuse(EXAMPLE_REMOVAL_MESSAGES.tooMany)
      // I: no token while any window shows, or might show, an example talk.
      const open = this.#openWindows(listed.root)
      if (open !== null) return refuse(open)
      const { located, counted } = at
      const confirmation: Confirmation = {
        token: randomBytes(32).toString('hex'),
        sender,
        vaultId: listed.vault.id,
        present: located.kind === 'present',
        dev: located.kind === 'present' ? located.st.dev : 0,
        ino: located.kind === 'present' ? located.st.ino : 0,
        entries: counted.entries,
        talks: counted.talks,
        at: this.#now(),
      }
      this.#confirmation = confirmation
      return { ok: true, folder: EXAMPLE_DISPLAY_PATH, talks: counted.talks, token: confirmation.token }
    } catch (error) {
      this.#log('preview', 'failed', errorCode(error))
      return refuse(EXAMPLE_REMOVAL_MESSAGES.notPlain)
    }
  }

  /** Move the example vault to the Bin (rules B to E, H, I). Never throws; never closes a window. */
  remove(token: unknown, sender: number): Promise<ExampleRemoveResult> {
    // H: used up by any call, at the moment of the call.
    const held = this.#confirmation
    this.#confirmation = null
    const now = this.#now()
    const confirmed = held !== null
      && typeof token === 'string' && TOKEN_SHAPE.test(token) && token === held.token
      && sender === held.sender
      && now >= held.at && now - held.at < EXAMPLE_CONFIRMATION_MS
      ? held
      : null
    return this.#inTurn(async () => {
      if (confirmed === null) {
        this.#log('remove', 'not-confirmed')
        return refuse(EXAMPLE_REMOVAL_MESSAGES.lookAgain)
      }
      try {
        return await this.#remove(confirmed)
      } catch (error) {
        this.#log('remove', 'failed', errorCode(error))
        return refuse(EXAMPLE_REMOVAL_MESSAGES.notPlain)
      }
    })
  }

  /** Bring it back (rule F). Never throws. */
  restore(): Promise<ExampleRestoreResult> {
    return this.#inTurn(async () => {
      try {
        const result = await this.#deps.writer.open()
        if (!result.ok) {
          this.#log('restore', result.reason)
          return refuse(result.message)
        }
        this.#deps.record.setRemoved(false)
        this.#log('restore', result.outcome)
        return { ok: true, outcome: result.outcome, startTalk: result.startTalk }
      } catch (error) {
        this.#log('restore', 'failed', errorCode(error))
        return refuse(EXAMPLE_REMOVAL_MESSAGES.restoreFailed)
      }
    })
  }

  #inTurn<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work)
    this.#queue = next.catch(() => undefined)
    return next
  }

  async #remove(confirmed: Confirmation): Promise<ExampleRemoveResult> {
    // C, D and H: still the vault and the folder the person was shown.
    const again = await this.#same(confirmed)
    if ('message' in again) return again
    // I: asked last, with no wait between this answer and the trash call below.
    const open = this.#openWindows(again.root)
    if (open !== null) return refuse(open)

    if (again.kind === 'gone') {
      // E: binned in Finder. The list follows the disk; no trash call.
      if (!this.#offTheList(confirmed.vaultId)) return refuse(EXAMPLE_REMOVAL_MESSAGES.notRecorded)
      this.#log('remove', 'already-gone')
      return { ok: true, outcome: 'already-gone' }
    }

    // B: the one destructive call, on exactly the fixed path, before anything else changes.
    try {
      await this.#deps.trash(again.root)
    } catch (error) {
      this.#log('remove', 'trash-failed', errorCode(error))
      return refuse(EXAMPLE_REMOVAL_MESSAGES.trashFailed)
    }
    // A trash function that returned with the folder still there has not moved it.
    const after = await this.#lstatOrNull(again.root).catch(() => 'unknown' as const)
    if (after !== null) {
      this.#log('remove', 'trash-failed', 'STILL_PRESENT')
      return refuse(EXAMPLE_REMOVAL_MESSAGES.trashFailed)
    }
    if (!this.#offTheList(confirmed.vaultId)) {
      this.#log('remove', 'not-recorded')
      return refuse(EXAMPLE_REMOVAL_MESSAGES.notRecorded)
    }
    this.#log('remove', 'moved-to-bin')
    return { ok: true, outcome: 'moved-to-bin' }
  }

  /** The list's own remove, then the record. False when the list could not be written. */
  #offTheList(vaultId: string): boolean {
    try {
      this.#deps.registry.remove(vaultId)
    } catch (error) {
      this.#log('remove', 'list-failed', errorCode(error))
      return false
    }
    try { this.#deps.record.setRemoved(true) } catch { /* the list is the record that matters */ }
    return true
  }

  /** Rules C, D and H at one moment, against the confirmation. */
  async #same(confirmed: Confirmation): Promise<Extract<Located, { kind: 'present' | 'gone' }> | Refusal> {
    const listed = await this.#listed()
    if (!listed || listed.vault.id !== confirmed.vaultId) return refuse(EXAMPLE_REMOVAL_MESSAGES.notListed)
    const at = await this.#examine(listed.vault)
    if (!at.ok) return at
    const { located, counted } = at
    const sameFolder = located.kind === 'present'
      ? confirmed.present && located.st.dev === confirmed.dev && located.st.ino === confirmed.ino
      : !confirmed.present
    if (!sameFolder || counted.capped || counted.entries !== confirmed.entries || counted.talks !== confirmed.talks) {
      this.#log('remove', 'changed')
      return refuse(EXAMPLE_REMOVAL_MESSAGES.lookAgain)
    }
    return located
  }

  /** Rule C: the list's example entry at the fixed path, and the home's real path. */
  async #listed(): Promise<{ vault: Vault; root: string } | null> {
    const home = this.#deps.home()
    if (!home) return null
    let realHome: string
    try { realHome = await this.#fs.realpath(home) } catch { return null }
    const root = join(realHome, EXAMPLE_DOCUMENTS_NAME, EXAMPLE_PARENT_NAME, EXAMPLE_FOLDER_NAME)
    const vault = this.#deps.registry.list().find((v) => v.example === true && norm(v.root) === norm(root)) ?? null
    return vault ? { vault, root } : null
  }

  /** Rules C and D, and the count: what is at the fixed path now. */
  async #examine(vault: Vault): Promise<{ ok: true; located: Extract<Located, { kind: 'present' | 'gone' }>; counted: Counted } | Refusal> {
    const located = await this.#locate()
    if (located.kind === 'no-home') return refuse(EXAMPLE_REMOVAL_MESSAGES.noHome)
    if (located.kind === 'refused') {
      this.#log('remove', 'refused')
      return refuse(EXAMPLE_REMOVAL_MESSAGES.notPlain)
    }
    if (located.kind === 'gone') return { ok: true, located, counted: NOTHING }
    if (!(await this.#isTheExample(located.root, vault.id))) {
      this.#log('remove', 'not-example')
      return refuse(EXAMPLE_REMOVAL_MESSAGES.notExample)
    }
    return { ok: true, located, counted: await this.#count(located.root) }
  }

  /** Rules A and D. Each part a plain folder, each resolving directly inside the one above. */
  async #locate(): Promise<Located> {
    const home = this.#deps.home()
    if (!home) return { kind: 'no-home' }
    let realHome: string
    try { realHome = await this.#fs.realpath(home) } catch { return { kind: 'no-home' } }
    const documents = join(realHome, EXAMPLE_DOCUMENTS_NAME)
    const parent = join(documents, EXAMPLE_PARENT_NAME)
    const root = join(parent, EXAMPLE_FOLDER_NAME)
    const chain: Array<[string, string]> = [[documents, realHome], [parent, documents], [root, parent]]
    for (const [path, above] of chain) {
      const st = await this.#lstatOrNull(path)
      if (st === null) return path === documents ? { kind: 'no-home' } : { kind: 'gone', root }
      if (st.isSymbolicLink() || !st.isDirectory()) return { kind: 'refused' }
      const real = await this.#fs.realpath(path)
      if (norm(real) !== norm(path) || norm(dirname(real)) !== norm(above)) return { kind: 'refused' }
    }
    const st = await this.#fs.lstat(root)
    if (st.isSymbolicLink() || !st.isDirectory()) return { kind: 'refused' }
    return { kind: 'present', root, st }
  }

  /** Rule C: the example vault file, a plain file in a plain folder, flagged, with the list's id. */
  async #isTheExample(root: string, vaultId: string): Promise<boolean> {
    const dir = join(root, VAULT_FILE_DIR)
    const path = join(dir, VAULT_FILE_NAME)
    const dirStat = await this.#lstatOrNull(dir).catch(() => null)
    if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory()) return false
    const st = await this.#lstatOrNull(path).catch(() => null)
    if (!st || st.isSymbolicLink() || !st.isFile() || st.size > VAULT_FILE_MAX_BYTES) return false
    let text: string
    try { text = (await this.#fs.readFile(path)).toString('utf8') } catch { return false }
    const read = parseVaultFile(text)
    return read.state === 'ok' && read.file.example === true && read.file.id === vaultId
  }

  /**
   * Every entry under root (folders, files and links, links never followed), and the talks
   * (`*-outline.md` files outside TalkWeaver's own `.talkweaver` and `_SLIDE-VERSIONS` folders directly
   * inside root). Stops once past the limit and says so.
   */
  async #count(root: string): Promise<Counted> {
    let entries = 0
    let talks = 0
    const pending: Array<{ dir: string; records: boolean }> = [{ dir: root, records: false }]
    while (pending.length > 0 && entries <= EXAMPLE_COUNT_LIMIT) {
      const { dir, records } = pending.pop()!
      for await (const entry of await this.#fs.opendir(dir)) {
        entries += 1
        const inRecords = records || (dir === root && TALKWEAVER_RECORD_DIRS.has(entry.name))
        if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push({ dir: join(dir, entry.name), records: inRecords })
        else if (entry.isFile() && entry.name.endsWith('-outline.md') && !inRecords) talks += 1
        if (entries > EXAMPLE_COUNT_LIMIT) break
      }
    }
    return { entries, talks, capped: entries > EXAMPLE_COUNT_LIMIT }
  }

  /** Rule I: null when no window shows, or might show, an example talk; else the one sentence. A failing port counts as open. */
  #openWindows(root: string): string | null {
    let names: string[]
    try {
      names = this.#deps.openWindows(root)
      if (!Array.isArray(names)) throw new Error('not a list')
    } catch (error) {
      this.#log('remove', 'windows-unknown', errorCode(error))
      return EXAMPLE_REMOVAL_MESSAGES.windowsUnknown
    }
    if (names.length === 0) return null
    this.#log('remove', 'windows-open')
    return closeExampleTalksFirst(names)
  }

  async #lstatOrNull(path: string): Promise<Stats | null> {
    try {
      return await this.#fs.lstat(path)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null
      throw error
    }
  }

  #now(): number {
    return (this.#deps.now ?? Date.now)()
  }

  #log(action: 'preview' | 'remove' | 'restore', outcome: string, code?: string): void {
    try {
      this.#deps.log?.(`example-vault.${action}`, { outcome, ...(code ? { code } : {}) })
    } catch { /* logging never breaks a removal */ }
  }
}
