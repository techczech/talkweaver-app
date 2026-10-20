// The status bar chip as a pure model (work-files-and-sessions ticket 21; locked mockup section 6).
// The sessions of the open talk, the time now and the live set go in; the one chip to draw comes out,
// or null (absent). The phase and the progress text come from the Run checklist and the Sessions row
// (run-checklist.ts, sessions-list.ts), so the chip never re-derives a state. No Electron, no fs, no clock.
//
//   live now           "Saïd workshop · live now"                               red, pulsing dot
//   pre-work open      "Saïd workshop · Wed 21 Oct · pre-work 7/18"             blue, list-checks
//   pre-work closed    "Saïd workshop · Wed 21 Oct · pre-work closed 16/18"     amber, lock
//   post-work open     "Saïd workshop · post-work 5/18 · closes Wed 4 Nov"      blue, message-square-heart
//   anything else (not published, delivered with nothing open, no work files)   absent
//
// When a talk has several, a live Run wins, then the soonest upcoming Run, then the latest Run with
// post-work open.
import { dayLabel } from './run-checklist.ts'
import { sessionRow, sessionRunKey, isSessionRun, type SessionSource } from './sessions-list.ts'
import type { ToolsRunRef } from './tools-views.ts'

export type StatusChipTone = 'blue' | 'amber' | 'red'
export type StatusChipIcon = 'list-checks' | 'lock' | 'message-square-heart' | 'live-dot'
export interface StatusChip { ref: ToolsRunRef; text: string; tone: StatusChipTone; icon: StatusChipIcon }

interface Candidate { chip: StatusChip; rank: 0 | 1 | 2; sortKey: string }

function candidate(source: SessionSource, now: Date, live: boolean): Candidate | null {
  const { row, group, sortKey } = sessionRow(source, now, live)
  const name = row.name
  const ref = row.ref
  if (live) return { rank: 0, sortKey, chip: { ref, tone: 'red', icon: 'live-dot', text: `${name} · live now` } }
  if (!source.work?.pre && !source.work?.post) return null
  const date = source.plannedDate ? dayLabel(source.plannedDate) : ''
  const upcoming = (): string => [name, date, row.progress].filter(Boolean).join(' · ')
  if (row.phase === 'published' && group === 'upcoming' && source.work?.pre) {
    return { rank: 1, sortKey, chip: { ref, tone: 'blue', icon: 'list-checks', text: upcoming() } }
  }
  if (row.phase === 'pre-closed' && group === 'upcoming') {
    return { rank: 1, sortKey, chip: { ref, tone: 'amber', icon: 'lock', text: upcoming() } }
  }
  if (row.phase === 'post-open' && source.work?.post) {
    const closes = source.work.post.closes.slice(0, 10)
    return { rank: 2, sortKey, chip: { ref, tone: 'blue', icon: 'message-square-heart', text: `${name} · ${row.progress} · closes ${dayLabel(closes)}` } }
  }
  return null
}

export function statusChip(sources: readonly SessionSource[], live: ReadonlySet<string>, now: Date): StatusChip | null {
  const found: Candidate[] = []
  for (const source of sources) {
    if (!isSessionRun(source)) continue
    const item = candidate(source, now, live.has(sessionRunKey(source)))
    if (item) found.push(item)
  }
  found.sort((a, b) => a.rank - b.rank || (a.rank === 2 ? b.sortKey.localeCompare(a.sortKey) : a.sortKey.localeCompare(b.sortKey)))
  return found[0]?.chip ?? null
}

