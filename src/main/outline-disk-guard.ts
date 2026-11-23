// Outline external-change guard (shared-talk ticket 01). A talk's outline can change on disk while it
// is open: another TalkWeaver on a shared cloud-synced folder, a sync client, a text editor. The app must
// notice, offer a choice, and never write over the newer file (or recreate a removed one) without
// being told to.
//
// The guard keeps, per open outline file (keyed by its real path), the BASELINE: the version of the
// text the editor holds — the sha256 of the text it loaded or last saved, or ABSENT once the person has
// accepted that the file is gone. The file differs from the editor exactly when its version is not the
// baseline:
//   - `changed`  the file holds other text;
//   - `removed`  the file is gone (the app's own rename, move and talk delete call `forget` first, so
//                they never look like this; the app's delete of a FOLDER holding the open talk does
//                report it, so the person sees the talk go and nothing is recreated silently);
//   - `partial`  an app save failed after the file was truncated (talk-writer.ts reports it with
//                `failedHalfway`): the file may be incomplete, so it is never offered for Reload.
// Only the editor's own saves move the baseline (`written`, called by talk-writer.ts under the file's
// lock, so the watcher event a save causes finds the file equal to the baseline). A save whose text is
// already exactly what is on disk is accepted silently and moves the baseline too.
//
// Ways in:
//   - `track` when an editor window loads the talk (talk:read-outline with forEditor); its folder is
//     watched. `release` when the window switches talk or closes: the entry is dropped at once.
//   - the directory watcher, a change in the outline's sampled metadata, and window focus trigger
//     a check. A stopped directory watcher leaves the metadata, focus and save-time checks in place.
//   - talk-writer.ts asks `conflict` before every whole-text write of a tracked file, under the lock.
//   - `accept(hash)`: the person chose (Keep mine, Reload, Save it again, Save again) having seen version
//     `hash`; a file that changed again since is refused with the newer change.
import { createHash } from 'crypto'
import { lstat } from 'node:fs/promises'
import { sep } from 'path'
import type { OutlineDiskAccept, OutlineDiskChange } from '../shared/outline-disk-change.ts'

export interface OutlineDiskGuardDeps {
  /** The file's real path (outline-identity.ts canonicalOutlinePath): the guard's key. */
  canonical(outlinePath: string): string
  /** Enables metadata checks while at least one owner has a visible editor. */
  ownerIsVisible?(owner: string): boolean
  /** The file's text, or null when it does not exist (ENOENT). Other errors throw. */
  readText(realPath: string): Promise<string | null>
  /** The file's modification time (ms), or null when it does not exist. */
  mtime(realPath: string): Promise<number | null>
  /** Runs `work` holding the file's write lock (talk-writer.ts withTalkFileLock). */
  withLock<T>(outlinePath: string, work: () => Promise<T>): Promise<T>
  /** Starts watching `realPath`'s folder: `onChange` on any change in it (debounced), `onError` when the
   *  watcher stopped. May throw (the folder cannot be watched). `unwatch` stops it. */
  watch(realPath: string, onChange: () => void, onError: () => void): void
  unwatch(realPath: string): void
  /** Tells the window `owner` that its talk (`outlinePath`, its own alias) differs from the disk
   *  (change), or no longer does (null). */
  notify(owner: string, outlinePath: string, change: OutlineDiskChange | null): void
}

export interface OutlineDiskGuard {
  /** The editor window `owner` has loaded `text` from `outlinePath`: the baseline. Any other file
   *  `owner` had is released. */
  track(owner: string, outlinePath: string, text: string): void
  /** `owner` no longer has a talk open (switch, close): its entries are dropped and unwatched. */
  release(owner: string): void
  /** The app itself moves or deletes `path` (a file or a folder): every entry at or under it is dropped
   *  (its owners told there is nothing to choose), so the move is never reported as a removal. */
  forget(path: string): void
  /** The real paths of the open files at or under `path` (a file or a folder). The app's own delete of
   *  a folder holding an open talk takes these before it deletes, then `check`s each: the owners see
   *  the removal (the bar), and nothing is recreated unless they choose Save it again. */
  openUnder(path: string): string[]
  /** Whether writes to this real path are guarded. */
  tracks(realPath: string): boolean
  /** Whether window `owner` has `outlinePath` open (IPC requests are checked against it). */
  owns(owner: string, outlinePath: string): boolean
  /** Main-only identity of this owner's current editor load. Every track replaces it. */
  session(owner: string, outlinePath: string): object | null
  /** Whether the folder of this real path is being watched (false after a watcher error). */
  watching(realPath: string): boolean
  /** The unresolved difference last reported for `owner`'s talk, or null. */
  pendingFor(owner: string): OutlineDiskChange | null
  /** Before a whole-text write of `incoming`, under the lock: the difference when the file on disk
   *  (`diskText`, null = missing) is not the editor's version, else null. */
  conflict(realPath: string, diskText: string | null, incoming: string, expectedDiskHash?: string): Promise<OutlineDiskChange | null>
  /** Explicit Save it again is awaiting its write; ordinary autosave cannot grant this. */
  canRecreate(realPath: string): boolean
  /** The editor's text `text` is now on disk at `realPath` (under the lock): the new baseline. */
  written(realPath: string, text: string): void
  /** An app save failed after truncating the file; `tempPath` holds its full text. Returns the change
   *  reported to the owners (null when the file is not tracked). */
  failedHalfway(realPath: string, tempPath: string): OutlineDiskChange | null
  /** Re-reads the file (under the lock) and reports a new difference / a cleared one to the owners. */
  check(outlinePath: string): Promise<OutlineDiskChange | null>
  /** The file's text and version as it stands on disk (under the lock), or null when missing. */
  diskVersion(outlinePath: string): Promise<{ text: string; hash: string } | null>
  /** The person chose having seen version `hash`: it becomes the baseline, unless the file changed again
   *  (then the newer change, reported to the owners too). `keepPending` (Keep mine, Save it again, Save
   *  again — a save follows): the difference stays reported until that save lands. Bound to the owner's
   *  current editor load when queued; an expired session refuses without changing the entry. */
  accept(owner: string, outlinePath: string, hash: string, opts?: { keepPending?: boolean }): Promise<OutlineDiskAccept>
  /** The difference currently reported for the file, or null. */
  pending(outlinePath: string): OutlineDiskChange | null
  /** Stops every watcher (app quit, tests). */
  dispose(): void
}

export const hashOutlineText = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
/** The version of a missing file. */
export const ABSENT = 'removed'
const partialToken = (tempPath: string): string => `partial:${tempPath}`
const METADATA_CHECK_MS = 1000

async function metadataStamp(realPath: string): Promise<string | null | undefined> {
  try {
    const file = await lstat(realPath, { bigint: true })
    if (!file.isFile()) return undefined
    return `${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return undefined
  }
}

interface Entry {
  baseline: string
  /** A fresh record per editor load: identity fences queued requests across a reopen. */
  owners: Map<string, { path: string }>
  /** The difference last reported (so one version is reported once), or null. */
  reported: OutlineDiskChange | null
  /** Keep mine / Save it again / Save again was accepted and its save has not landed yet: the
   *  difference stays reported (the bar stays) until `written`. */
  awaitingSave: boolean
  /** A save that failed halfway, until the person saves again. */
  partial: { tempPath: string; at: number } | null
  watching: boolean
  metadataTimer?: ReturnType<typeof setTimeout>
}

export function createOutlineDiskGuard(deps: OutlineDiskGuardDeps): OutlineDiskGuard {
  const entries = new Map<string, Entry>()
  const firstPath = (entry: Entry, fallback: string): string => entry.owners.values().next().value?.path ?? fallback

  // The one place a difference (or its end) reaches the owners: each version is reported once.
  const report = (entry: Entry, change: OutlineDiskChange | null): void => {
    if (change === null && entry.awaitingSave) return // cleared only by the save landing (`written`)
    if (change === null ? entry.reported === null : entry.reported?.hash === change.hash) return
    if (change) entry.awaitingSave = false // a newer difference: the person has to choose again
    entry.reported = change
    for (const [owner, { path: ownerPath }] of entry.owners) {
      try { deps.notify(owner, ownerPath, change && { ...change, outlinePath: ownerPath }) } catch { /* a closed window */ }
    }
  }

  // The difference between the file (its version `token`) and the entry, or null when there is none.
  const differenceFor = async (realPath: string, entry: Entry, token: string): Promise<OutlineDiskChange | null> => {
    const outlinePath = firstPath(entry, realPath)
    if (entry.partial) {
      return { outlinePath, kind: 'partial', hash: partialToken(entry.partial.tempPath), changedAt: entry.partial.at, tempPath: entry.partial.tempPath }
    }
    if (token === entry.baseline) return null
    if (token === ABSENT) return { outlinePath, kind: 'removed', hash: ABSENT, changedAt: Date.now() }
    let changedAt = Date.now()
    try { changedAt = (await deps.mtime(realPath)) ?? changedAt } catch { /* keep now */ }
    return { outlinePath, kind: 'changed', hash: token, changedAt }
  }

  const versionOf = (text: string | null): string => text === null ? ABSENT : hashOutlineText(text)

  const drop = (realPath: string, entry: Entry): void => {
    clearTimeout(entry.metadataTimer)
    if (entry.watching) { entry.watching = false; try { deps.unwatch(realPath) } catch { /* already gone */ } }
    if (entries.get(realPath) === entry) entries.delete(realPath)
  }

  // Whether `realPath` is `root` (already canonical) or inside it.
  const isUnder = (realPath: string, root: string): boolean =>
    realPath === root || realPath.startsWith(root.endsWith(sep) ? root : root + sep)

  const releaseFrom = (owner: string, except?: string): void => {
    for (const [realPath, entry] of [...entries]) {
      if (realPath === except || !entry.owners.delete(owner)) continue
      if (entry.owners.size === 0) drop(realPath, entry)
    }
  }

  // Under the lock: read, compare, report. A file that cannot be read now reports nothing (the next
  // save's own read refuses with the error).
  const recheck = async (realPath: string): Promise<OutlineDiskChange | null> => {
    const entry = entries.get(realPath)
    if (!entry) return null
    let text: string | null
    try { text = await deps.readText(realPath) } catch { return entry.reported }
    const change = await differenceFor(realPath, entry, versionOf(text))
    if (entries.get(realPath) !== entry) return null
    report(entry, change)
    return change
  }

  const requestCheck = (realPath: string, entry: Entry): void => {
    void deps.withLock(realPath, async () => {
      if (entries.get(realPath) !== entry) return null
      return recheck(realPath)
    }).catch(() => undefined)
  }

  // Native directory events can be late or absent. Only changes to the outline's metadata
  // request a read, and the normal locked comparison decides whether the editor needs a notice.
  const startMetadataChecks = (realPath: string, entry: Entry, ownerIsVisible: (owner: string) => boolean): void => {
    let previous: string | null | undefined
    const sample = async (): Promise<void> => {
      if ([...entry.owners.keys()].some(ownerIsVisible)) {
        const stamp = await metadataStamp(realPath)
        if (entries.get(realPath) !== entry) return
        if (stamp !== undefined && stamp !== previous) {
          previous = stamp
          requestCheck(realPath, entry)
        }
      }
      schedule()
    }
    const schedule = (): void => {
      entry.metadataTimer = setTimeout(() => { void sample() }, METADATA_CHECK_MS)
      entry.metadataTimer.unref()
    }
    schedule()
  }

  const startWatching = (realPath: string, entry: Entry): void => {
    try {
      deps.watch(
        realPath,
        () => requestCheck(realPath, entry),
        () => { entry.watching = false },
      )
      entry.watching = true
    } catch {
      entry.watching = false // the metadata, focus and save-time checks still work
    }
  }

  return {
    track(owner, outlinePath, text) {
      const realPath = deps.canonical(outlinePath)
      releaseFrom(owner, realPath)
      let entry = entries.get(realPath)
      if (!entry) {
        entry = { baseline: '', owners: new Map(), reported: null, awaitingSave: false, partial: null, watching: false }
        entries.set(realPath, entry)
      }
      entry.baseline = hashOutlineText(text)
      entry.partial = null
      entry.awaitingSave = false
      entry.owners.set(owner, { path: outlinePath })
      report(entry, null)
      if (!entry.watching) startWatching(realPath, entry)
      if (deps.ownerIsVisible && !entry.metadataTimer) startMetadataChecks(realPath, entry, deps.ownerIsVisible)
    },
    release(owner) { releaseFrom(owner) },
    forget(path) {
      const root = deps.canonical(path)
      for (const [realPath, entry] of [...entries]) {
        if (!isUnder(realPath, root)) continue
        entry.awaitingSave = false
        report(entry, null)
        drop(realPath, entry)
      }
    },
    openUnder(path) {
      const root = deps.canonical(path)
      return [...entries.keys()].filter((realPath) => isUnder(realPath, root))
    },
    tracks: (realPath) => entries.has(realPath),
    owns(owner, outlinePath) {
      const entry = entries.get(deps.canonical(outlinePath))
      return !!entry && entry.owners.has(owner)
    },
    session: (owner, outlinePath) => entries.get(deps.canonical(outlinePath))?.owners.get(owner) ?? null,
    watching: (realPath) => entries.get(realPath)?.watching ?? false,
    pending(outlinePath) {
      const entry = entries.get(deps.canonical(outlinePath))
      return entry?.reported ? { ...entry.reported, outlinePath } : null
    },
    pendingFor(owner) {
      for (const entry of entries.values()) {
        const session = entry.owners.get(owner)
        if (session && entry.reported) return { ...entry.reported, outlinePath: session.path }
      }
      return null
    },
    async conflict(realPath, diskText, incoming, expectedDiskHash) {
      const entry = entries.get(realPath)
      if (!entry) return null
      const token = versionOf(diskText)
      // The file already holds exactly this text (the other side made the same edit, or a save that
      // landed before a crash): nothing to overwrite, and the editor now holds the disk's version.
      if (!entry.partial && diskText !== null && token === hashOutlineText(incoming)) {
        entry.baseline = token
        report(entry, null)
        return null
      }
      // Save again / Save it again has explicit versioned permission to replace partial bytes
      // or recreate a removed file; an adopted buffer may still carry its older disk hash.
      const explicitRecovery = entry.awaitingSave && token === entry.baseline &&
        (entry.reported?.kind === 'partial' || entry.reported?.kind === 'removed')
      if (expectedDiskHash && !entry.partial && !explicitRecovery) {
        if (diskText !== null && token === expectedDiskHash) return null
        const change: OutlineDiskChange = {
          outlinePath: firstPath(entry, realPath), kind: token === ABSENT ? 'removed' : 'changed', hash: token, changedAt: Date.now(),
        }
        report(entry, change)
        return change
      }
      const change = await differenceFor(realPath, entry, token)
      report(entry, change)
      return change
    },
    canRecreate(realPath) {
      const entry = entries.get(realPath)
      return !!entry?.awaitingSave && entry.baseline === ABSENT && entry.reported?.kind === 'removed'
    },
    written(realPath, text) {
      const entry = entries.get(realPath)
      if (!entry) return
      entry.baseline = hashOutlineText(text)
      entry.partial = null
      entry.awaitingSave = false
      report(entry, null)
    },
    failedHalfway(realPath, tempPath) {
      const entry = entries.get(realPath)
      if (!entry) return null
      entry.partial = { tempPath, at: Date.now() }
      const change: OutlineDiskChange = { outlinePath: firstPath(entry, realPath), kind: 'partial', hash: partialToken(tempPath), changedAt: entry.partial.at, tempPath }
      report(entry, change)
      return change
    },
    check(outlinePath) {
      const realPath = deps.canonical(outlinePath)
      if (!entries.has(realPath)) return Promise.resolve(null)
      return deps.withLock(outlinePath, () => recheck(realPath))
    },
    async diskVersion(outlinePath) {
      const realPath = deps.canonical(outlinePath)
      const sample = () => deps.withLock(outlinePath, async () => {
        const text = await deps.readText(realPath)
        return { text, mtime: await deps.mtime(realPath) }
      })
      let before = await sample()
      let matching = 1
      for (let attempt = 0; attempt < 6; attempt++) {
        // Require three matching text/metadata samples across at least 400 ms. External tools
        // need not take our lock; never hold it while waiting for a paused writer to finish.
        await new Promise(resolve => setTimeout(resolve, 200))
        const after = await sample()
        matching = before.text === after.text && before.mtime === after.mtime ? matching + 1 : 1
        if (matching >= 3) {
          return after.text === null ? null : { text: after.text, hash: hashOutlineText(after.text) }
        }
        before = after
      }
      throw new Error('The outline is still changing on disk. Nothing was merged; retry after the other editor finishes saving.')
    },
    accept(owner, outlinePath, hash, opts = {}) {
      const realPath = deps.canonical(outlinePath)
      const session = entries.get(realPath)?.owners.get(owner)
      const refused = (): OutlineDiskAccept => ({ ok: false, change: null, error: 'The talk was closed or reloaded before acceptance finished. Review its disk changes again.' })
      return deps.withLock(outlinePath, async (): Promise<OutlineDiskAccept> => {
        const entry = entries.get(realPath)
        if (!entry || !session || !entry.owners.has(owner) || entry.owners.get(owner) !== session) return refused()
        // track/release run outside this lock. Fence every awaited read before mutating the entry.
        const current = (): boolean => entries.get(realPath) === entry && entry.owners.get(owner) === session
        let text: string | null
        try { text = await deps.readText(realPath) } catch (error) {
          return { ok: false, change: null, error: error instanceof Error ? error.message : String(error) }
        }
        if (!current()) return refused()
        const token = versionOf(text)
        if (entry.partial) {
          // Save again after a half-finished save: the person accepts that the file is incomplete.
          if (hash !== partialToken(entry.partial.tempPath)) {
            const change = await differenceFor(realPath, entry, token)
            return current() ? { ok: false, change: change && { ...change, outlinePath } } : refused()
          }
          entry.partial = null
        } else if (token !== hash) {
          // Changed again since the person looked: report the newer version instead.
          const change = await differenceFor(realPath, entry, token)
          if (!current()) return refused()
          report(entry, change)
          return { ok: false, change: change ? { ...change, outlinePath } : null }
        }
        // Reconciliation can discover removal before the watcher updates this report.
        // Save it again must retain removal permission, including for an adopted buffer's hash.
        if (token === ABSENT && opts.keepPending && entry.reported?.kind !== 'removed') {
          report(entry, { outlinePath: firstPath(entry, realPath), kind: 'removed', hash: ABSENT, changedAt: Date.now() })
        }
        entry.baseline = token
        if (opts.keepPending && entry.reported) entry.awaitingSave = true
        else { entry.awaitingSave = false; report(entry, null) }
        return { ok: true }
      })
    },
    dispose() {
      for (const [realPath, entry] of [...entries]) drop(realPath, entry)
    },
  }
}
