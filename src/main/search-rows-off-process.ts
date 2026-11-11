// The search index's per-slide rows, compiled in the live compile's own process rather than on the
// main process's thread (a projections-only compile of a 150-slide talk held the main process for
// 140-270 ms at a time, the beachball while the index warmed).
//
// What changes is only where the compile runs and how long it may take: the job waits its turn on
// the preparation gate's background lane (one compile at a time in the compile's process, never ahead
// of the live deck's compile) and comes back as rows only, so no deck crosses to the main process.
// Because it can now wait, the source may have moved on by the time rows arrive. Rows are therefore
// judged against a stamp read before the source is read and again after the compile:
//   - the talk's vault is no longer open: the rows belong to a vault nobody is searching; none.
//   - anything else moved (the outline was saved again or renamed, another compiler, entries dropped
//     from the index): the rows are of a revision that is no longer current. The current source is
//     read and compiled once more; if that moves too, the talk has no rows this time (`stale`), and
//     the next look tries again. Rows known to be stale are never returned.
//
// No Electron import: plain-Node tests load this file.

export type SearchRowsStamp = {
  /** The talk's vault is still one of the open vaults. */
  vaultOpen: boolean
  /** Outline mtime (null: gone), compiler tag and the index's reset count, as one comparable string. */
  revision: string
}

export type SearchRowsOutcome<Row, Source> =
  /** Rows of `source`, current when the compile ended: safe to show and to keep. */
  | { rows: Row[]; source: Source; stale: false }
  /** No rows: none could be made (`stale` false), or the source kept moving (`stale` true). */
  | { rows: null; stale: boolean }

/** Thrown by a caller that must tell "the source kept moving" apart from "the talk cannot be read". */
export class StaleSearchRowsError extends Error {
  constructor(path: string) { super(`the outline changed while its search rows were made: ${path}`); this.name = 'StaleSearchRowsError' }
}

export async function prepareSearchRows<Row, Source>(deps: {
  stamp: () => SearchRowsStamp
  /** Reads the current source (synchronously, right after the stamp). */
  read: () => Source
  /** The projections-only compile of `source`, off the main process's thread. */
  compile: (source: Source) => Promise<Row[] | null>
}, attempts = 2): Promise<SearchRowsOutcome<Row, Source>> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const before = deps.stamp()
    if (!before.vaultOpen) return { rows: null, stale: false }
    const source = deps.read()
    const rows = await deps.compile(source)
    if (!rows) return { rows: null, stale: false }
    const after = deps.stamp()
    if (!after.vaultOpen) return { rows: null, stale: false }
    if (after.revision === before.revision) return { rows, source, stale: false }
  }
  return { rows: null, stale: true }
}
