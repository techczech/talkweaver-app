import { useEffect, useState } from 'react'
import { formatShortDate, lastDeliveredBySlug } from '../components/talklist/model.ts'
import type { TalkHandouts, TalkMeta } from '../../../preload/index'

// Talk facts — the facts several surfaces read about every talk in the vault: search-index
// metadata (slide counts, created/edited, cover, warnings), the last DELIVERY per talk and the
// published-handout state. Talks-panel rows, the preview card and (since T29) the status bar's
// dates segment all read from ONE store here, so two consumers cause one IPC fetch, and every
// consumer refreshes together when main says the facts changed:
//   · `vault:talk-meta-updated` — search-index counts landed, pathways changed, or a delivery
//     session was saved (main broadcasts on all three);
//   · an explicit `reload()` — e.g. the vault's talk list changed (new/rename/move).
// The store is module-level: TalkList unmounts on sidebar-tab switches, and a remount must not
// re-fetch what is already cached. Nothing here touches the DOM; `subscribeTalkFacts`/
// `refreshTalkFacts` are the testable seam (`scripts/test-talk-facts.mjs`).

export interface TalkFactsData {
  meta: TalkMeta
  lastDelivered: Record<string, number>
  handouts: TalkHandouts
}

export interface TalkFacts extends TalkFactsData {
  /** Re-fetch all three IPC sources; concurrent calls share one fetch. */
  reload: () => Promise<void>
}

export type TalkFactsListener = (facts: TalkFactsData) => void

const EMPTY: TalkFactsData = { meta: {}, lastDelivered: {}, handouts: {} }

let cache: TalkFactsData | null = null
let inflight: Promise<void> | null = null
const listeners = new Set<TalkFactsListener>()
let unsubscribeMetaUpdated: (() => void) | null = null

async function fetchFacts(): Promise<void> {
  if (inflight) return inflight
  inflight = (async () => {
    let next: TalkFactsData
    try {
      const [meta, sessions, handouts] = await Promise.all([
        window.tw.vault.talkMeta(),
        window.tw.recording.listAllSessions(),
        window.tw.history.talkHandouts()
      ])
      next = { meta: meta || {}, lastDelivered: lastDeliveredBySlug(sessions || []), handouts: handouts || {} }
    } catch {
      // A vault hiccup reads as "no facts yet" — surfaces show nothing rather than stale data.
      next = EMPTY
    }
    inflight = null
    cache = next
    for (const notify of [...listeners]) notify(next)
  })()
  return inflight
}

/** Receive the shared facts (immediately when cached, else after the first fetch) until the
 *  returned unsubscribe runs. The last unsubscribe also drops the main-process subscription. */
export function subscribeTalkFacts(notify: TalkFactsListener): () => void {
  listeners.add(notify)
  if (!unsubscribeMetaUpdated) {
    unsubscribeMetaUpdated = window.tw.vault.onTalkMetaUpdated?.(() => { void fetchFacts() }) ?? null
  }
  if (cache) notify(cache)
  else if (!inflight) void fetchFacts()
  return () => {
    listeners.delete(notify)
    if (listeners.size === 0 && unsubscribeMetaUpdated) {
      unsubscribeMetaUpdated()
      unsubscribeMetaUpdated = null
    }
  }
}

export function refreshTalkFacts(): Promise<void> {
  return fetchFacts()
}

/** React binding for the shared facts store. */
export function useTalkFacts(): TalkFacts {
  const [facts, setFacts] = useState<TalkFactsData>(() => cache ?? EMPTY)
  useEffect(() => subscribeTalkFacts(setFacts), [])
  return { ...facts, reload: refreshTalkFacts }
}

// ── status-bar dates segment ─────────────────────────────────────────────────────────────

export interface TalkDates {
  createdMs?: number | null
  editedMs?: number | null
  deliveredMs?: number | null
}

export interface TalkDatePart {
  text: string
  /** Full date and time, for the hover title. */
  title?: string
}

/** The dates segment parts, e.g. `Created 29 Jun · Edited 18 Jul · Delivered never` (Dominik,
 *  T29). Same compact formatting as the preview card (formatShortDate — recent dates read
 *  today/yesterday/Nd ago, the year appears only outside the current year); each part carries
 *  the full date and time as its title. An empty array means "show nothing": metadata that has
 *  not loaded yet must not render as placeholder dashes. */
export function formatTalkDates(dates: TalkDates): TalkDatePart[] {
  const parts: TalkDatePart[] = []
  if (dates.createdMs) parts.push(datedPart('Created', dates.createdMs))
  if (dates.editedMs) parts.push(datedPart('Edited', dates.editedMs))
  parts.push(dates.deliveredMs ? datedPart('Delivered', dates.deliveredMs) : { text: 'Delivered never' })
  return parts
}

function datedPart(label: string, ms: number): TalkDatePart {
  const d = new Date(ms)
  return {
    text: `${label} ${formatShortDate(ms)}`,
    title: Number.isFinite(d.getTime()) ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : undefined
  }
}
