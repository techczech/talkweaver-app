import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

// Light per-talk delivery summaries for talk search: where and when each talk was given.
//
// A Run file (`<vault>/_PRESENTATIONS/<talk-slug>/<run-id>.json`) can carry a whole transcript,
// slide-time index and poll responses, so talk search never reads Runs per keystroke. It keeps
// only the few fields it searches (date, event title, context, audience) per Run file, keyed by
// the file's mtime and size. A revalidation stats every Run file (cheap: ~25 files today) and
// re-reads only files that are new or changed; deleted files drop out. Revalidation runs at most
// once per `revalidateMs`, so a burst of keystrokes costs one stat pass.

export interface DeliverySummary {
  runId: string
  talkSlug: string
  status: 'delivered' | 'planned'
  /** YYYY-MM-DD: the local start date of a delivered Run, the planned date of a planned one. */
  date: string
  eventTitle: string
  context: string
  audience: string
}

type FileEntry = { mtimeMs: number; size: number; summary: DeliverySummary | null }

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function localIsoDate(value: string): string {
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** The searchable part of one Run, or null for rehearsals, recordings and unreadable files. */
export function summariseRun(raw: unknown, fallbackSlug: string): DeliverySummary | null {
  if (!raw || typeof raw !== 'object') return null
  const run = raw as Record<string, unknown>
  // Only deliveries say where a talk was given (CONTEXT.md: Kind). Absent kind = delivery.
  if (run.kind === 'rehearsal' || run.kind === 'recording') return null
  const status = run.status === 'planned' ? 'planned' : 'delivered'
  const planned = /^\d{4}-\d{2}-\d{2}$/.test(text(run.plannedDate)) ? text(run.plannedDate) : ''
  const date = status === 'planned' ? planned : (localIsoDate(text(run.startedAt)) || planned)
  return {
    runId: text(run.id),
    talkSlug: text(run.talkSlug) || fallbackSlug,
    status,
    date,
    eventTitle: text(run.eventTitle),
    context: text(run.context),
    audience: text(run.audience)
  }
}

export function createDeliverySummaries(options: {
  vaultRoot: () => string | null
  revalidateMs?: number
  now?: () => number
}) {
  const revalidateMs = options.revalidateMs ?? 1000
  const now = options.now ?? Date.now
  let files = new Map<string, FileEntry>()
  let root: string | null = null
  let checkedAt = -Infinity
  let bySlug = new Map<string, DeliverySummary[]>()
  let parsed = 0

  function revalidate(vaultRoot: string): void {
    const next = new Map<string, FileEntry>()
    const base = join(vaultRoot, '_PRESENTATIONS')
    let slugs: string[] = []
    try {
      slugs = readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    } catch { /* no History yet */ }
    for (const slug of slugs) {
      let names: string[]
      try { names = readdirSync(join(base, slug)) } catch { continue }
      for (const name of names) {
        if (!name.endsWith('.json') || name === 'manifest.json') continue
        const path = join(base, slug, name)
        let st
        try { st = statSync(path) } catch { continue }
        if (!st.isFile()) continue
        const prior = files.get(path)
        if (prior && prior.mtimeMs === st.mtimeMs && prior.size === st.size) {
          next.set(path, prior)
          continue
        }
        let summary: DeliverySummary | null = null
        try {
          parsed += 1
          summary = summariseRun(JSON.parse(readFileSync(path, 'utf8')), slug)
        } catch { /* a malformed Run never breaks search */ }
        next.set(path, { mtimeMs: st.mtimeMs, size: st.size, summary })
      }
    }
    files = next
    const map = new Map<string, DeliverySummary[]>()
    for (const { summary } of files.values()) {
      if (!summary || !summary.talkSlug) continue
      const list = map.get(summary.talkSlug) ?? []
      list.push(summary)
      map.set(summary.talkSlug, list)
    }
    // Most recent first; the order is fixed so match lines are deterministic.
    for (const list of map.values()) {
      list.sort((a, b) => b.date.localeCompare(a.date) || a.runId.localeCompare(b.runId))
    }
    bySlug = map
  }

  return {
    /** Delivery summaries per talk slug, most recent first. */
    bySlug(): Map<string, DeliverySummary[]> {
      const vaultRoot = options.vaultRoot()
      if (!vaultRoot) return new Map()
      const t = now()
      if (vaultRoot !== root || t - checkedAt >= revalidateMs) {
        if (vaultRoot !== root) files = new Map()
        root = vaultRoot
        revalidate(vaultRoot)
        checkedAt = t
      }
      return bySlug
    },
    /** Force the next call to re-stat (after a Run write this process made). */
    invalidate(): void {
      checkedAt = -Infinity
    },
    /** How many Run files were read and parsed so far (tests: summaries stay light). */
    parsedCount(): number {
      return parsed
    }
  }
}

export type DeliverySummaries = ReturnType<typeof createDeliverySummaries>
