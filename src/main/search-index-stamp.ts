// The Slide Browser's freshness stamp for its held whole-index rows (slide-browser drawing ticket,
// review round 1).
//
// The Browser keeps the empty-query reply and shows it again when the search is cleared, without a
// new scan, but only while that reply is still what a scan would return now. A counter bumped by
// main's own writers cannot promise that: a sync client or another editor changes an outline with
// no event reaching main, and the next scan (ensureTalkRows) would see the new mtime. So freshness is
// asked of the same facts a scan decides by: the open vaults, the talk list (findTalks), each
// outline's mtime on disk, the compiler (thumbCacheRoot) and the index's reset count. The scan's
// reply carries the stamp taken BEFORE it read anything; clearing the search asks main for the
// stamp now and reuses the rows only when the two are equal. A change during the scan therefore
// always reads as stale (the start stamp has the old mtime), never as current.
import { createHash } from 'crypto'

export interface StampVault { id: string; root: string }
export interface StampTalk { outlinePath: string; slug: string; title: string }

export interface StampInput {
  /** The searched talks, in scan order, with their vault. */
  talks: ReadonlyArray<{ vaultId: string; vaultRoot: string; talk: StampTalk }>
  /** The outline's mtime on disk now; null when it cannot be read (missing). */
  mtimeOf: (outlinePath: string) => number | null
  /** The compiler the rows are built with (a new compiler rebuilds every talk's rows). */
  compilerTag: string
  /** Rises whenever the search index drops entries (a vault change, a ledger or tag write). */
  resets: number
}

/** A short digest of every fact a whole-index scan's rows depend on. */
export function searchIndexStamp(input: StampInput): string {
  const h = createHash('sha1')
  h.update(`c\0${input.compilerTag}\0r\0${input.resets}\n`)
  for (const { vaultId, vaultRoot, talk } of input.talks) {
    const m = input.mtimeOf(talk.outlinePath)
    h.update(`${vaultId}\0${vaultRoot}\0${talk.outlinePath}\0${talk.slug}\0${talk.title}\0${m === null ? '-' : m}\n`)
  }
  return h.digest('hex')
}

/** The talks a scan would search NOW. The talk lists findTalks holds for a few seconds are bypassed: a
 *  talk a sync client added or removed within that window must change the stamp (the cache is only a
 *  speed-up for callers that can tolerate an old list). The fresh list is handed back to `remember`
 *  so those callers also see it. One directory walk per open vault. */
export function currentSearchTalks<T>(
  vaults: ReadonlyArray<{ id: string; root: string }>,
  scanFresh: (root: string) => T[],
  remember: (root: string, talks: T[]) => void
): Array<{ vaultId: string; vaultRoot: string; talk: T }> {
  const out: Array<{ vaultId: string; vaultRoot: string; talk: T }> = []
  for (const { id: vaultId, root: vaultRoot } of vaults) {
    const talks = scanFresh(vaultRoot)
    remember(vaultRoot, talks)
    for (const talk of talks) out.push({ vaultId, vaultRoot, talk })
  }
  return out
}

/** Marks a reply whose rows lack a talk the scan could not load. A probe stamp is always a hex digest,
 *  so a marked stamp never equals one: the Browser rescans on clear for as long as a talk keeps failing,
 *  and a talk that loads later cannot leave the held (incomplete) set looking current. */
export const INCOMPLETE_STAMP_PREFIX = 'incomplete:'

/** Run a scan with the stamp taken before it starts: the stamp says what the rows can be trusted for.
 *  `skippedAny` (read after the scan) says a talk was skipped; the stamp is then marked incomplete. */
export async function scanWithStartStamp<T>(stampNow: () => string, scan: () => Promise<T>, skippedAny: () => boolean = () => false): Promise<{ stamp: string; result: T }> {
  const start = stampNow()
  const result = await scan()
  return { stamp: start && skippedAny() ? INCOMPLETE_STAMP_PREFIX + start : start, result }
}
