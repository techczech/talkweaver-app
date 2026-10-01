// The compare screen's main-process side (several-vaults ticket 10; architecture.md "Conflict copies"
// merge paragraph, invariants 2 and 3; "Decisions after the locked mockups": several copies one at a
// time, oldest first, and the per-talk Activity list; LOCKED-conflict frames 2, 3, 4 and 6).
//
//   load(outlinePath)   reads the talk (the open editor's buffer when a window has it, else the file)
//                       and its oldest differing conflict copy — or, first, the two sides of Git
//                       markers inside the outline — and answers both versions as slides, matched
//                       and marked. It remembers the bytes it compared under a token. Writes nothing.
//   check(token)        has either file changed on disk since the load? (the screen polls it: "Start
//                       again"). Writes nothing.
//   merge(token, pick)  keeps one whole version and inserts the ticked slides of the other
//                       (conflict-merge.mjs). Refuses with `stale` when the talk or the copy changed
//                       since the load (re-checked inside the write, under the talk's file lock on the
//                       disk route; against the buffer on the editor route). Then, in this order:
//                         1. when the text being replaced is not kept whole elsewhere (keeping the other
//                            version, or any Git-marker merge), it is first written to a new file beside
//                            the outline, "<outline> (before merge <time>).md" (never over a file);
//                         2. ONE write of the outline through the normal save path (talk-writer.ts);
//                         3. a ledger save (with lineage for re-stamped ids);
//                         4. under the talk's file lock, the copy (only if its bytes are still the ones
//                            compared) and the before-merge file go to the OS Trash (never unlink); a
//                            file that cannot be trashed is left beside the talk and reported;
//                         5. one Activity line that names only what was really trashed or left; the
//                            folder is scanned again (the badge goes).
//                       Every line of both versions is then in the outline, in a file in the Trash, or
//                       in a file left beside the talk (named in the result and the Activity line).
//                       If the outline write fails, the before-merge file is trashed only while the
//                       outline still holds exactly that text; otherwise it is left beside the talk and
//                       reported (it may then be the only copy of that text). Nothing is ever unlinked.
//                       With the talk open, the write goes through the editor, whose save has reached
//                       disk when the write returns (talk-writer.ts EditorBuffer.commit): the file,
//                       not only the buffer, holds the merge, so a Git-marker badge does not return.
//   cancel(token)       forgets the token. Writes nothing.
//
// Nothing is written outside the talk's folder (the before-merge file is checked to stay inside the
// vault's writable root), and nothing at all while the vault is unavailable (`writableRoot`).

import { randomBytes } from 'crypto'
import { existsSync, lstatSync, readFileSync, statSync, writeFileSync } from 'fs'
import { readdir } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { classifyConflict, conflictCandidateNames, sourceLabel, type ConflictCopy } from './conflict-copies.mjs'
import { compareVersions, mergeConflict, splitGitConflict, type ComparedSlide, type OutlineDeps } from './conflict-merge.mjs'
import type { ActivityEntry } from './talk-activity'

export type DiffLine = { kind: 'same' | 'del' | 'add'; text: string }
/** A compared slide; a differing one carries the line difference of the pair (− Mine, + the other). */
export type CompareSlide = ComparedSlide & { diff?: DiffLine[] }
export type CompareSide = { label: string; where: string; savedAt: string | null; text: string; slides: CompareSlide[] }
export type CompareLoad =
  | {
      ok: true
      token: string
      kind: 'copy' | 'git'
      title: string
      copyName: string | null
      service: ConflictCopy['service']
      mine: CompareSide
      theirs: CompareSide
      headDiffers: boolean
      /** Copies (and Git markers) of this talk still to compare, this one included. */
      remaining: number
    }
  | { ok: false; error: string }
export type CompareCheck = { stale: false } | { stale: true; which: 'mine' | 'theirs'; label: string; at: string | null }
export type MergePick = { keep: 'mine' | 'theirs'; pull: number[] }
export type MergeResult =
  | { ok: true; added: number; summary: string; text: string; trashed: string[]; copyLeft: boolean; setAsideLeft: string | null }
  /** `setAsideLeft`: the before-merge file left beside the talk (its name), when it could not go. */
  | { ok: false; error: string; stale?: boolean; setAsideLeft?: string }

export type WriteResult = { ok: true; via: 'disk' | 'editor'; changed: boolean; text: string } | { ok: false; error: string }

export interface ConflictCompareDeps {
  outlineLib(): Promise<OutlineDeps & { mintId: (rng: () => number, taken: Set<string>) => string; lineDiff?: (a: string, b: string) => DiffLine[] }>
  /** The talk as the person has it: the open editor's buffer, else the file (readTalkOutline). */
  readTalk(outlinePath: string): Promise<string>
  /** The normal save path (writeTalkOutline, origin 'conflict-merge'). */
  writeTalk(outlinePath: string, next: (current: string) => string, opts: { beforeEditorApply?(text: string): void | Promise<void> }): Promise<WriteResult>
  withLock<T>(outlinePath: string, work: () => Promise<T>): Promise<T>
  trashItem(path: string): Promise<void>
  /** The vault's writable root for this path, only while the vault is open and its folder is there. */
  writableRoot(outlinePath: string): string | undefined
  staysInside(root: string, candidate: string): string | null
  vaultIdOf(outlinePath: string): string | null
  knownMachines(vaultId: string): string[] | Promise<string[]>
  activity: { append(vaultId: string, slug: string, entry: ActivityEntry): Promise<void> }
  /** Ledger save of the text now in the file; `lineage` maps a re-stamped id to the id it came from. */
  ledgerSave(outlinePath: string, text: string, lineage: Map<string, string>): Promise<void>
  /** The folder changed: scan it again (the badge count). */
  rescan(folder: string): Promise<void>
  now?(): Date
  log?(message: string): void
}

type Session = {
  outlinePath: string
  folder: string
  vaultId: string
  slug: string
  kind: 'copy' | 'git'
  copyName: string | null
  canonicalBytes: Buffer
  copyBytes: Buffer | null
  /** The talk's text as read at load (buffer or file): what a merge replaces. */
  current: string
  mineText: string
  theirsText: string
  mineLabel: string
  theirsLabel: string
  compared: ReturnType<typeof compareVersions>
}

const STALE = 'The talk changed while you were comparing. Nothing has been merged. Start again to compare the latest versions.'
const OUTLINE_SUFFIX = '-outline.md'

function bytesOf(path: string): Buffer | null {
  try {
    if (!lstatSync(path).isFile()) return null
    return readFileSync(path)
  } catch { return null }
}
function mtimeOf(path: string): string | null {
  try { return statSync(path).mtime.toISOString() } catch { return null }
}
function titleOf(text: string, fallback: string): string {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const t = fm?.[1].match(/^title:[ \t]*(.+)$/m)?.[1].trim().replace(/^["']|["']$/g, '')
  return t || fallback
}
function stamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`
}

export function createConflictCompare(deps: ConflictCompareDeps) {
  const sessions = new Map<string, Session>()
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? (() => {})

  async function load(outlinePath: string): Promise<CompareLoad> {
    if (typeof outlinePath !== 'string' || !outlinePath.endsWith(OUTLINE_SUFFIX)) return { ok: false, error: 'This is not a talk.' }
    const root = deps.writableRoot(outlinePath)
    if (!root || !deps.staysInside(root, outlinePath)) return { ok: false, error: 'The talk’s vault is not available on this Mac, so it cannot be compared.' }
    const vaultId = deps.vaultIdOf(outlinePath)
    if (!vaultId) return { ok: false, error: 'The talk is in no open vault.' }
    const folder = dirname(outlinePath)
    const outlineName = basename(outlinePath)
    const slug = outlineName.slice(0, -OUTLINE_SUFFIX.length)
    const canonicalBytes = bytesOf(outlinePath)
    if (!canonicalBytes) return { ok: false, error: 'The talk’s file could not be read.' }
    let names: string[]
    try { names = (await readdir(folder, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name) } catch { return { ok: false, error: 'The talk’s folder could not be read.' } }
    let machines: string[] = []
    try { machines = (await deps.knownMachines(vaultId)) ?? [] } catch { machines = [] }
    const options = { knownMachines: machines }
    const entries = conflictCandidateNames(names, outlineName, options).map((name) => ({ name, bytes: bytesOf(join(folder, name)) }))
    const copies = classifyConflict(entries, { name: outlineName, bytes: canonicalBytes }, options).filter((c) => c.state !== 'identical')
    if (!copies.length) return { ok: false, error: 'There is no conflict copy of this talk left to compare.' }
    // Git markers first (they are in the talk itself), then the copies, oldest first.
    const ordered = [...copies].sort((a, b) => {
      if (a.state === 'git-markers') return -1
      if (b.state === 'git-markers') return 1
      return (mtimeOf(join(folder, a.name)) ?? '').localeCompare(mtimeOf(join(folder, b.name)) ?? '')
    })
    const copy = ordered[0]
    let current: string
    try { current = await deps.readTalk(outlinePath) } catch (error) { return { ok: false, error: `The talk could not be read (${(error as Error)?.message ?? error}).` } }
    const lib = await deps.outlineLib()
    let mineText: string
    let theirsText: string
    let mineWhere = 'this Mac'
    let theirsLabel: string
    let copyBytes: Buffer | null = null
    if (copy.state === 'git-markers') {
      const sides = splitGitConflict(current)
      if (!sides) return { ok: false, error: 'The talk no longer holds Git conflict markers.' }
      mineText = sides.ours
      theirsText = sides.theirs
      mineWhere = sides.oursLabel ? `Git · ${sides.oursLabel}` : 'Git · this side'
      theirsLabel = sides.theirsLabel ?? 'The other side'
    } else {
      copyBytes = bytesOf(join(folder, copy.name))
      if (!copyBytes) return { ok: false, error: 'The conflict copy could not be read.' }
      mineText = current
      theirsText = copyBytes.toString('utf8')
      theirsLabel = sourceLabel(copy.source) ?? 'The other copy'
    }
    const compared = compareVersions(mineText, theirsText, lib)
    // The line difference of each differing pair, always read as − Mine, + the other version.
    const diff = (a: string, b: string): DiffLine[] | undefined => (lib.lineDiff ? lib.lineDiff(a, b) : undefined)
    const mineSlides: CompareSlide[] = compared.a.map((sl) => (sl.differs ? { ...sl, diff: diff(sl.text, sl.match >= 0 ? compared.b[sl.match].text : '') } : sl))
    const theirsSlides: CompareSlide[] = compared.b.map((sl) => (sl.differs ? { ...sl, diff: diff(sl.match >= 0 ? compared.a[sl.match].text : '', sl.text) } : sl))
    const token = randomBytes(12).toString('hex')
    sessions.set(token, {
      outlinePath, folder, vaultId, slug, kind: copy.state === 'git-markers' ? 'git' : 'copy', copyName: copy.state === 'git-markers' ? null : copy.name,
      canonicalBytes, copyBytes, current, mineText, theirsText, mineLabel: 'Mine', theirsLabel, compared
    })
    const outlineSaved = mtimeOf(outlinePath)
    return {
      ok: true,
      token,
      kind: copy.state === 'git-markers' ? 'git' : 'copy',
      title: titleOf(current, slug),
      copyName: copy.state === 'git-markers' ? null : copy.name,
      service: copy.service,
      mine: { label: 'Mine', where: mineWhere, savedAt: outlineSaved, text: mineText, slides: mineSlides },
      theirs: {
        label: theirsLabel,
        where: copy.state === 'git-markers' ? 'Git · incoming' : copy.name,
        savedAt: copy.state === 'git-markers' ? outlineSaved : mtimeOf(join(folder, copy.name)),
        text: theirsText,
        slides: theirsSlides
      },
      headDiffers: compared.headDiffers,
      remaining: copies.length
    }
  }

  /** Which file changed on disk since the load, or null. The talk's own file counts as unchanged when
   *  it now holds exactly the text the load read (the editor saved the buffer it had). */
  function changed(s: Session): 'mine' | 'theirs' | null {
    const disk = bytesOf(s.outlinePath)
    if (!disk || (!disk.equals(s.canonicalBytes) && disk.toString('utf8') !== s.current)) return 'mine'
    if (s.copyName) {
      const copy = bytesOf(join(s.folder, s.copyName))
      if (!copy || !s.copyBytes || !copy.equals(s.copyBytes)) return 'theirs'
    }
    return null
  }

  function check(token: string): CompareCheck {
    const s = sessions.get(token)
    if (!s) return { stale: true, which: 'mine', label: 'this Mac', at: null }
    const which = changed(s)
    if (!which) return { stale: false }
    const path = which === 'theirs' && s.copyName ? join(s.folder, s.copyName) : s.outlinePath
    return { stale: true, which, label: which === 'theirs' ? s.theirsLabel : 'this Mac', at: mtimeOf(path) }
  }

  /** A new file beside the outline holding `text` (never over an existing file); its path, or null. */
  function writeBeforeMerge(s: Session, root: string, text: string): string | null {
    const stem = basename(s.outlinePath).slice(0, -3)
    const when = stamp(now())
    for (let n = 1; n < 100; n += 1) {
      const name = n === 1 ? `${stem} (before merge ${when}).md` : `${stem} (before merge ${when} ${n}).md`
      const path = join(s.folder, name)
      if (!deps.staysInside(root, path)) return null
      if (existsSync(path)) continue
      try { writeFileSync(path, text, { encoding: 'utf8', flag: 'wx' }); return path } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') continue
        throw error
      }
    }
    return null
  }

  async function merge(token: string, pick: MergePick): Promise<MergeResult> {
    const s = sessions.get(token)
    if (!s) return { ok: false, stale: true, error: STALE }
    if (pick?.keep !== 'mine' && pick?.keep !== 'theirs') return { ok: false, error: 'Choose the version to keep.' }
    const otherSlides = pick.keep === 'mine' ? s.compared.b : s.compared.a
    const pull = [...new Set(Array.isArray(pick.pull) ? pick.pull : [])]
    if (pull.some((i) => !Number.isInteger(i) || !otherSlides[i]?.differs)) return { ok: false, error: 'Only slides that differ can be added.' }
    const root = deps.writableRoot(s.outlinePath)
    if (!root || !deps.staysInside(root, s.outlinePath)) return { ok: false, error: 'The talk’s vault is not available on this Mac, so nothing was merged.' }
    if (changed(s)) return { ok: false, stale: true, error: STALE }

    const keptText = pick.keep === 'mine' ? s.mineText : s.theirsText
    const otherText = pick.keep === 'mine' ? s.theirsText : s.mineText
    const lib = await deps.outlineLib()
    const merged = mergeConflict({ kept: keptText, other: otherText, pull }, lib)
    const lineage = new Map(merged.restamped.map((r) => [r.to, r.from]))

    // 1. The text being replaced, when it is not kept whole elsewhere, is written out first.
    let beforeMerge: string | null = null
    if (s.kind === 'git' || pick.keep === 'theirs') {
      try { beforeMerge = writeBeforeMerge(s, root, s.current) } catch (error) {
        return { ok: false, error: `Your version could not be set aside before the merge (${(error as Error)?.message ?? error}). Nothing was merged.` }
      }
      if (!beforeMerge) return { ok: false, error: 'Your version could not be set aside before the merge. Nothing was merged.' }
    }

    // 2. One write through the normal save path. The transformation runs on the talk as it is now (the
    // file under its lock, or the open editor's buffer): anything changed since the load refuses.
    let staleInWrite = false
    const written = await deps.writeTalk(s.outlinePath, (current) => {
      if (current !== s.current || changed(s)) { staleInWrite = true; throw new Error(STALE) }
      return merged.text
    }, {
      // Editor route: the lineage of re-stamped ids is the ledger's first record of them, before the
      // editor's own save ledgers the text (the detach pattern).
      beforeEditorApply: (text) => deps.ledgerSave(s.outlinePath, text, lineage)
    })
    if (!written.ok) {
      // The outline was not written. The set-aside file is only a duplicate while the outline still
      // holds exactly that text: then it goes to the Trash. Otherwise (or if the Trash refuses) it is
      // left beside the talk and named: it may be the only copy of that text. Never unlinked.
      let setAsideLeft: string | undefined
      if (beforeMerge) {
        const disk = bytesOf(s.outlinePath)
        let gone = false
        if (disk && disk.toString('utf8') === s.current) {
          try { await deps.trashItem(beforeMerge); gone = true } catch (error) { log(`[conflict-merge] set-aside file not trashed: ${(error as Error)?.message ?? error}`) }
        }
        if (!gone) setAsideLeft = basename(beforeMerge)
      }
      const left = setAsideLeft ? ` Your version was set aside beside the talk as “${setAsideLeft}”.` : ''
      if (staleInWrite) return { ok: false, stale: true, error: STALE + left, ...(setAsideLeft ? { setAsideLeft } : {}) }
      return { ok: false, error: `Nothing was merged: ${written.error}${left}`, ...(setAsideLeft ? { setAsideLeft } : {}) }
    }

    // 3. Ledger save of the text now in the talk.
    try { await deps.ledgerSave(s.outlinePath, written.text, lineage) } catch { /* a ledger failure never fails a merge */ }

    // 4. The version not kept goes to the Trash, under the talk's file lock. The merge is written by
    // now: whatever fails here is reported honestly (left beside the talk), never as a failed merge.
    const trashed: string[] = []
    let copyLeft = false
    let setAsideLeft: string | null = beforeMerge ? basename(beforeMerge) : null
    try {
      await deps.withLock(s.outlinePath, async () => {
        if (s.copyName) {
          const copyPath = join(s.folder, s.copyName)
          const onDisk = bytesOf(copyPath)
          if (onDisk && s.copyBytes && onDisk.equals(s.copyBytes) && deps.staysInside(root, copyPath)) {
            try { await deps.trashItem(copyPath); trashed.push(s.copyName) } catch (error) { copyLeft = true; log(`[conflict-merge] copy not trashed: ${(error as Error)?.message ?? error}`) }
          } else if (onDisk) copyLeft = true
        }
        if (beforeMerge) {
          try { await deps.trashItem(beforeMerge); trashed.push(basename(beforeMerge)); setAsideLeft = null } catch (error) { log(`[conflict-merge] before-merge file left beside the talk: ${(error as Error)?.message ?? error}`) }
        }
      })
    } catch (error) {
      log(`[conflict-merge] after the write, the Trash step failed: ${(error as Error)?.message ?? error}`)
      if (s.copyName && !trashed.includes(s.copyName) && bytesOf(join(s.folder, s.copyName))) copyLeft = true
    }

    // 5. One Activity line; the folder is scanned again.
    const keptLabel = pick.keep === 'mine' ? 'Mine' : s.theirsLabel
    const otherLabel = pick.keep === 'mine' ? s.theirsLabel : 'Mine'
    const keptSlides = pick.keep === 'mine' ? s.compared.a : s.compared.b
    const where = (a: { after: number | null }): string => (a.after === null ? 'at the end' : `after slide ${a.after + 1}`)
    const addedText = merged.added.length === 0
      ? 'added nothing'
      : merged.added.length === 1
        ? `added slide ${merged.added[0].from + 1} from ${otherLabel} ${where(merged.added[0])}`
        : `added from ${otherLabel}: ${merged.added.map((a) => `slide ${a.from + 1} ${where(a)}`).join(', ')}`
    const copyTrashed = !!s.copyName && trashed.includes(s.copyName)
    const setAsideTrashed = !!beforeMerge && !setAsideLeft
    const leftBeside = setAsideLeft ? ` beside the talk as “${setAsideLeft}”` : ''
    const removed = s.kind === 'git'
      ? setAsideTrashed ? 'The version with the conflict markers was moved to the Trash.' : `The version with the conflict markers was kept${leftBeside}.`
      : copyTrashed ? 'The copy was moved to the Trash.' : 'The copy could not be moved or changed meanwhile, so it was left in the folder.'
    const setAside = s.kind === 'copy' && pick.keep === 'theirs'
      ? setAsideTrashed ? ' Your version before the merge was moved to the Trash.' : ` Your version before the merge was kept${leftBeside}.`
      : ''
    const entry: ActivityEntry = {
      at: now().toISOString(),
      kind: 'conflict-merged',
      title: s.kind === 'git' ? 'Resolved the Git conflict' : `Merged the conflict copy from ${s.theirsLabel}`,
      detail: `Kept ${keptLabel}; ${addedText}. ${removed}${setAside}`,
      kept: pick.keep,
      added: merged.added.length,
      keptSlides: keptSlides.length
    }
    try { await deps.activity.append(s.vaultId, s.slug, entry) } catch (error) { log(`[conflict-merge] activity line not written: ${(error as Error)?.message ?? error}`) }
    sessions.delete(token)
    try { await deps.rescan(s.folder) } catch { /* the next folder event scans it */ }

    const n = merged.added.length
    const firstAfter = merged.added[0]?.after
    const summary = [
      'Merged.',
      n === 0 ? '' : n === 1 ? `1 slide added ${firstAfter == null ? 'at the end' : `after slide ${firstAfter + 1}`}.` : `${n} slides added.`,
      s.kind === 'git' ? 'The conflict markers are gone.' : copyTrashed ? 'The conflict copy was removed.' : 'The conflict copy was left in the folder.',
      setAsideLeft ? `Your earlier version was kept beside the talk as “${setAsideLeft}”.` : ''
    ].filter(Boolean).join(' ')
    return { ok: true, added: n, summary, text: written.text, trashed, copyLeft, setAsideLeft }
  }

  function cancel(token: string): void { sessions.delete(token) }

  /** The compared text of one version (for its pictures), or null for an unknown token. */
  function versionText(token: string, side: 'mine' | 'theirs'): { outlinePath: string; text: string } | null {
    const s = sessions.get(token)
    return s ? { outlinePath: s.outlinePath, text: side === 'theirs' ? s.theirsText : s.mineText } : null
  }

  return { load, check, merge, cancel, versionText }
}
