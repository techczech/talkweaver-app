// Sync-conflict copies of a talk's outline (several-vaults ticket 09; design:
// docs/design/2026-09-29-multi-vault/architecture.md, "Conflict copies"; invariants 2 and 5).
//
// A file is a conflict copy of outline `S.md` when it sits in the same folder and is named
//   OneDrive      `S-<Machine>.md`            (and `<slug>-<Machine>-outline.md`, the form that used
//                                              to shadow the real outline in the scan's pick)
//   Dropbox       `S (<…>conflicted copy<…>).md`
//   Google Drive  `S (1).md` / `S(1).md`       (any 1–2 digit number)
//   iCloud Drive  `S 2.md`, `S 3.md`, …          (2 to 99; only when the contents are related, below)
//   Syncthing     `S.sync-conflict-<YYYYMMDD>-<HHMMSS>-<device>.md` (device: 7 upper-case letters or digits)
// or when `S.md` itself holds Git conflict markers at line starts (`<<<<<<< `, `=======`, `>>>>>>> `).
//
// A `<Machine>` suffix (letters, digits, `-`, `_`) counts only when (review S3, orchestrator):
//   (a) it is this Mac's name or another machine name seen for this vault (`knownMachines`, slugged
//       the way OneDrive writes them: see `machineSlug`), compared ignoring case; or
//   (b) it looks like a machine name, judged on whole hyphen-separated tokens (ignoring case): some
//       token is mac, macbook, imac, mini, pc, air, pro or studio, or the suffix is DESKTOP-<token> or
//       LAPTOP-<token> (Windows' default names).
// So `S-EN.md`, `S-v2.md`, `S-Draft.md`, `S-notes.md`, `S-machine.md`, `S-minimal.md`,
// `S-final-draft.md` are the author's own files, never copies, unless the name is a known machine.
// `loose` (the vault walk, the outline pick) accepts any suffix token: it only decides which folders
// the scanner looks at, and the scanner applies the rule above.
//
// iCloud's ` 2` is also what a person gets from Finder's "Keep both", or types for a second talk, so
// the name alone is not enough: an iCloud-named file counts only when it is related to `S` (0.45,
// second Mac): byte-identical, or sharing a slide id (`{id=…}`) with it, or carrying the same
// frontmatter title. A file that is none of these (another talk called "… 2", or one that cannot be
// read) is the author's own and is neither counted nor moved. Syncthing's name is distinctive enough
// on its own. Neither service names a machine the owner would recognise, so their `source` is null.
// iCloud and Syncthing copies of `X-outline.md` end in ` 2.md` or `.md` after the conflict stamp,
// never in `-outline.md`, so they never enter the outline pick (talk-scan.mjs pickOutlineName).
//
// This module has three layers:
//   - pure naming and classification (`conflictServiceOf`, `conflictCandidateNames`,
//     `hasGitConflictMarkers`, `classifyConflict`) — table-tested in scripts/test-conflict-copies.mjs;
//   - `createConflictScanner` — reads one talk folder, classifies, and moves byte-identical copies to
//     the OS Trash through the injected `trashItem` (never unlink), writing one Activity line each.
//     Differing copies and Git markers are only counted: nothing is written.
// The vault walk (vault-index.mjs) finds candidate names from the listing it already has; the
// scanner is called only for folders with a candidate or with markers, so no second tree walk runs.
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { ID_TOKEN_RE } from '../../compiler/scripts/lib/slide-id.mjs'

const OUTLINE_SUFFIX = '-outline.md'
const toBuffer = (b) => (b == null ? null : Buffer.isBuffer(b) ? b : typeof b === 'string' ? Buffer.from(b, 'utf8') : Buffer.from(b))
const MACHINE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const MACHINE_TOKENS = new Set(['mac', 'macbook', 'imac', 'mini', 'pc', 'air', 'pro', 'studio'])
const WINDOWS_DEFAULT = /^(desktop|laptop)-[A-Za-z0-9_]+/i

/** A computer name as OneDrive puts it in a file name: apostrophes dropped, spaces to hyphens, other
 *  characters dropped ("Dominik’s MacBook Air" → "Dominiks-MacBook-Air"). */
export function machineSlug(name) {
  return String(name ?? '').replace(/\.local$/i, '').replace(/['’]/g, '').trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9_-]/g, '')
}

/** Whether `token` names a machine under rule (a)/(b) above (`loose`: any token). */
export function isMachineName(token, { knownMachines = [], loose = false } = {}) {
  if (typeof token !== 'string' || !MACHINE.test(token) || /(^|-)outline$/i.test(token)) return false
  if (loose) return true
  const lower = token.toLowerCase()
  if (knownMachines.some((m) => machineSlug(m).toLowerCase() === lower && lower !== '')) return true
  if (WINDOWS_DEFAULT.test(token)) return true
  return token.split('-').some((part) => MACHINE_TOKENS.has(part.toLowerCase()))
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const SYNC_CONFLICT = /^\.sync-conflict-\d{8}-\d{6}-[A-Z0-9]{7}$/
const ICLOUD_NUMBER = /^ ([2-9]|[1-9]\d)$/
const ID_TOKENS = new RegExp(ID_TOKEN_RE.source, 'g')

/** The slide ids an outline's text carries, and its frontmatter title (null when it has none). */
function outlineMarks(text) {
  const ids = new Set([...text.matchAll(ID_TOKENS)].map((m) => m[1]))
  const front = text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/)
  const raw = front?.[1].match(/^title:[ \t]*(.*?)[ \t]*$/m)?.[1] ?? ''
  const title = raw.replace(/^(['"])(.*)\1$/, '$2').trim()
  return { ids, title: title || null }
}

/** Whether a copy's bytes are related to the outline's: identical, a shared slide id, or the same title. */
export function relatedOutline(copyBytes, canonicalBytes) {
  const copy = toBuffer(copyBytes)
  const canonical = toBuffer(canonicalBytes)
  if (!copy || !canonical || copy.length === 0 || canonical.length === 0) return false
  if (copy.equals(canonical)) return true
  const a = outlineMarks(copy.toString('utf8'))
  const b = outlineMarks(canonical.toString('utf8'))
  for (const id of a.ids) if (b.ids.has(id)) return true
  return a.title !== null && a.title === b.title
}

/**
 * The service that named `name` as a conflict copy of `canonicalName`, or null.
 * @returns {{ service: 'onedrive' | 'dropbox' | 'gdrive' | 'icloud' | 'syncthing', source: string | null } | null}
 */
export function conflictServiceOf(name, canonicalName, options = {}) {
  if (typeof name !== 'string' || typeof canonicalName !== 'string') return null
  if (!canonicalName.endsWith('.md') || !name.endsWith('.md')) return null
  if (name === canonicalName || name.toLowerCase() === canonicalName.toLowerCase()) return null
  if (name.includes('/') || name.includes('\\')) return null
  const base = canonicalName.slice(0, -3) // S
  const stem = name.slice(0, -3)
  // OneDrive: S-<Machine>.md
  if (stem.startsWith(base + '-')) {
    const machine = stem.slice(base.length + 1)
    if (isMachineName(machine, options)) return { service: 'onedrive', source: machine }
  }
  // OneDrive, machine inserted before -outline: <slug>-<Machine>-outline.md
  if (canonicalName.endsWith(OUTLINE_SUFFIX) && name.endsWith(OUTLINE_SUFFIX)) {
    const slug = canonicalName.slice(0, -OUTLINE_SUFFIX.length)
    const other = name.slice(0, -OUTLINE_SUFFIX.length)
    if (other.startsWith(slug + '-')) {
      const machine = other.slice(slug.length + 1)
      if (isMachineName(machine, options)) return { service: 'onedrive', source: machine }
    }
  }
  // Dropbox: S (<…>conflicted copy<…>).md
  const dropbox = stem.match(new RegExp(`^${escapeRe(base)} \\((.*conflicted copy.*)\\)$`, 'i'))
  if (dropbox) {
    const who = dropbox[1].match(/^(.+?)['’]s conflicted copy/i)
    return { service: 'dropbox', source: who ? who[1].trim() : null }
  }
  // Google Drive: S (1).md / S(1).md
  if (new RegExp(`^${escapeRe(base)} ?\\(\\d{1,2}\\)$`).test(stem)) return { service: 'gdrive', source: null }
  // Syncthing: S.sync-conflict-YYYYMMDD-HHMMSS-DEVICE.md
  const rest = stem.startsWith(base) ? stem.slice(base.length) : null
  if (rest !== null && SYNC_CONFLICT.test(rest)) return { service: 'syncthing', source: null }
  // iCloud Drive: S 2.md (the contents decide: classifyConflict)
  if (rest !== null && ICLOUD_NUMBER.test(rest)) return { service: 'icloud', source: null }
  return null
}

/** The names in a folder listing that are conflict copies of `canonicalName`, in listing order. */
export function conflictCandidateNames(names, canonicalName, options = {}) {
  return (names ?? []).filter((n) => conflictServiceOf(n, canonicalName, options) !== null)
}

/** True when the text holds a Git conflict block: `<<<<<<< ` then `=======` then `>>>>>>> `, each at
 *  a line start, in that order. A lone `=======` (a Markdown heading underline) is not one, and
 *  lines inside a fenced code block (``` or ~~~) never count (a talk may show a conflict as code). */
export function hasGitConflictMarkers(text) {
  if (typeof text !== 'string' || !text.includes('<<<<<<<')) return false
  let stage = 0
  let fence = null // the opening fence run (e.g. '```' or '~~~~') while inside a code block
  for (const line of text.split(/\r?\n/)) {
    const run = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1]
    if (fence) {
      if (run && run[0] === fence[0] && run.length >= fence.length && line.trim() === run) fence = null
      continue
    }
    if (run) { fence = run; continue }
    if (stage === 0 && /^<{7}( |$)/.test(line)) stage = 1
    else if (stage === 1 && /^={7}\s*$/.test(line)) stage = 2
    else if (stage === 2 && /^>{7}( |$)/.test(line)) return true
  }
  return false
}


/**
 * Pure classification of one talk folder.
 * @param {Array<{ name: string, bytes?: Buffer | Uint8Array | string | null }>} listing the folder's
 *   files; `bytes` is needed for a candidate to be judged identical (missing bytes → `differs`).
 * @param {{ name: string, bytes: Buffer | Uint8Array | string }} canonicalOutline the talk's outline.
 * @returns {Array<{ name: string, service: 'onedrive'|'dropbox'|'gdrive'|'icloud'|'syncthing'|'git', source: string|null,
 *   state: 'identical'|'differs'|'git-markers' }>} copies in listing order; a `git-markers` entry
 *   (named as the outline itself) comes first when the outline holds markers.
 */
export function classifyConflict(listing, canonicalOutline, options = {}) {
  const out = []
  if (!canonicalOutline || typeof canonicalOutline.name !== 'string') return out
  const canonical = toBuffer(canonicalOutline.bytes)
  if (canonical && hasGitConflictMarkers(canonical.toString('utf8'))) {
    out.push({ name: canonicalOutline.name, service: 'git', source: null, state: 'git-markers' })
  }
  for (const entry of listing ?? []) {
    const match = conflictServiceOf(entry?.name, canonicalOutline.name, options)
    if (!match) continue
    const bytes = toBuffer(entry.bytes)
    // An iCloud-style name is a copy only when its contents are related to the outline (header).
    if (match.service === 'icloud' && !relatedOutline(bytes, canonical)) continue
    // An empty outline is never the reference for "identical" (review T1): nothing is trashed.
    const identical = Boolean(canonical && canonical.length > 0 && bytes && bytes.equals(canonical))
    out.push({ name: entry.name, service: match.service, source: match.source, state: identical ? 'identical' : 'differs' })
  }
  return out
}

/** "MacBook-Air" → "MacBook Air"; a Dropbox owner as given; null when the service does not say. */
export function sourceLabel(source) {
  return typeof source === 'string' && source ? source.replace(/[-_]+/g, ' ').trim() : null
}

/** The Activity line for an identical copy moved to the Trash (LOCKED-conflict frame 5). */
export function identicalCopyActivity(copy, at) {
  const from = sourceLabel(copy.source)
  return {
    at,
    kind: 'identical-copy-removed',
    copyName: copy.name,
    service: copy.service,
    title: from ? `Removed an identical copy from ${from}` : `Removed an identical copy (${copy.name})`,
    detail: 'It matched this file byte for byte, so nothing was lost.'
  }
}

/**
 * The folder scanner. Deps:
 *   trashItem(path)        — moves the file to the OS Trash (shell.trashItem); never an unlink.
 *   staysInside(root, p)   — path-containment.ts pathStaysInside: the real path or null.
 *   activity               — { append(vaultId, slug, entry) } (talk-activity.ts).
 *   canTouch(vaultId)      — false for a closed or unavailable vault: nothing is read or moved.
 *   withLock(path, work)   — runs `work` holding the outline's write lock (talk-writer.ts
 *                            withTalkFileLock): the last byte check and the move happen under it.
 *   knownMachines(vaultId) — machine names seen for the vault (this Mac's included), for rule (a).
 *   rememberMachines(vaultId, names) — a OneDrive copy named a machine: remember it for the vault.
 *   fs                     — optional { readFile, readdir, lstat, realpath } (tests).
 *   now()                  — ISO time for the Activity line.
 */
export function createConflictScanner({
  trashItem, staysInside, activity, canTouch = () => true, withLock = (_path, work) => work(),
  knownMachines = () => [], rememberMachines = () => {}, fs = {}, now = () => new Date().toISOString(), log = () => {}
}) {
  const io = {
    readFile: fs.readFile ?? readFile,
    readdir: fs.readdir ?? readdir,
    lstat: fs.lstat ?? lstat,
    realpath: fs.realpath ?? realpath
  }

  async function bytesOf(path) {
    try {
      const st = await io.lstat(path)
      if (!st.isFile()) return null // a link or folder is never judged identical (never trashed)
      return await io.readFile(path)
    } catch { return null }
  }

  /** Move one identical copy to the Trash, after every check again. Returns true when trashed. */
  async function trashIdentical(folder, canonicalName, name, options) {
    if (typeof name !== 'string' || !name || name !== basename(name) || name === '.' || name === '..') return false
    if (name.toLowerCase() === canonicalName.toLowerCase()) return false // never the outline itself
    if (!conflictServiceOf(name, canonicalName, options)) return false
    const copyPath = join(folder, name)
    const canonicalPath = join(folder, canonicalName)
    const realCopy = staysInside(folder, copyPath)
    if (!realCopy) return false
    let realCanonical
    try { realCanonical = await io.realpath(canonicalPath) } catch { return false }
    if (realCopy === realCanonical) return false
    try {
      const [a, b] = await Promise.all([io.lstat(copyPath), io.lstat(canonicalPath)])
      if (!a.isFile()) return false
      if (a.dev === b.dev && a.ino === b.ino) return false // a hard link to the outline
    } catch { return false }
    // Bytes again, right before the move, holding the outline's write lock (no app save lands in
    // between): a copy (or the outline) that changed since the scan stays; an empty outline is never
    // the reference.
    return withLock(canonicalPath, async () => {
      const [copyBytes, canonicalBytes] = await Promise.all([bytesOf(copyPath), bytesOf(canonicalPath)])
      if (!copyBytes || !canonicalBytes || canonicalBytes.length === 0 || !copyBytes.equals(canonicalBytes)) return false
      await trashItem(copyPath)
      return true
    })
  }

  /**
   * Scan one talk folder. `names` is the folder listing when the caller has it (the vault walk).
   * @returns {Promise<{ conflicts: number, copies: ReturnType<typeof classifyConflict>, trashed: string[] } | null>}
   *   null when the vault may not be touched or the outline cannot be read.
   */
  async function scanFolder({ vaultId, folder, outlineName, slug, names }) {
    if (!canTouch(vaultId)) return null
    const canonicalPath = join(folder, outlineName)
    const canonicalBytes = await bytesOf(canonicalPath)
    if (!canonicalBytes) return null
    let listing = names
    if (!Array.isArray(listing)) {
      try {
        listing = (await io.readdir(folder, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name)
      } catch { return null }
    }
    let machines = []
    try { machines = (await knownMachines(vaultId)) ?? [] } catch { machines = [] }
    const options = { knownMachines: machines }
    const candidates = conflictCandidateNames(listing, outlineName, options)
    const entries = []
    for (const name of candidates) entries.push({ name, bytes: await bytesOf(join(folder, name)) })
    const copies = classifyConflict(entries, { name: outlineName, bytes: canonicalBytes }, options)
    const seen = copies.filter((c) => c.service === 'onedrive' && c.source).map((c) => c.source)
    if (seen.length) { try { await rememberMachines(vaultId, seen) } catch { /* best effort */ } }
    const trashed = []
    const remaining = []
    for (const copy of copies) {
      if (copy.state !== 'identical') { remaining.push(copy); continue }
      if (!canTouch(vaultId)) { remaining.push({ ...copy, state: 'differs' }); continue }
      let moved = false
      try { moved = await trashIdentical(folder, outlineName, copy.name, options) } catch (error) {
        log(`[conflict-copies] trash failed for ${copy.name}: ${error?.message ?? error}`)
      }
      if (!moved) {
        // Gone already (another scan moved it, or the person did): nothing to show.
        const still = await io.lstat(join(folder, copy.name)).then(() => true, () => false)
        if (still) remaining.push({ ...copy, state: 'differs' })
        continue
      }
      trashed.push(copy.name)
      try { await activity.append(vaultId, slug, identicalCopyActivity(copy, now())) } catch (error) {
        log(`[conflict-copies] activity line not written: ${error?.message ?? error}`)
      }
    }
    // A copy that was identical but could not be moved is shown (it may have changed): never hidden.
    return { conflicts: remaining.length, copies: remaining, trashed }
  }

  return { scanFolder }
}

/**
 * The vault holding `path` when the path is a REAL path (the external-change guard watches real
 * paths) and a vault's root is registered through a symlink (review S1): each vault's root is
 * resolved with `realpath` and the deepest one containing `path` wins. Returns the vault and the
 * vault-relative path ('/'-separated, '' for the root), or null.
 * @template {{ root: string }} V
 * @param {V[]} vaults @param {string} path @param {(p: string) => string} realpath
 * @returns {{ vault: V, rel: string } | null}
 */
export function resolveByRealRoot(vaults, path, realpath) {
  let best = null
  for (const vault of vaults ?? []) {
    let realRoot
    try { realRoot = realpath(vault.root) } catch { continue }
    const rel = relative(realRoot, path)
    if (rel.startsWith('..') || isAbsolute(rel)) continue
    if (!best || realRoot.length > best.len) best = { vault, rel: rel.split(sep).join('/'), len: realRoot.length }
  }
  return best ? { vault: best.vault, rel: best.rel } : null
}
