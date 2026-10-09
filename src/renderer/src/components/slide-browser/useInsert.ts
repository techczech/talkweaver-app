// Insert (contract identical to SearchPalette) and the duplicate merge it can nudge towards.
import { useRef } from 'react'
import { notify } from '../../lib/notify'
import {
  type DisplayCard, type MergeRequest, type SlideCluster,
  clusterMergeable, mergeNudgeLabel, mergeTargetsFromCluster, selRowKey
} from '../slideBrowserModel'
import { selectedRowsFor } from '../talkBesideModel'
import { rowTitle } from './browserHelpers'
import { insertItemsFor } from '../../../../shared/slide-insert-source'
import type { SearchResult } from './types'

export function useInsert({
  vRows, activePos, selected, fullRows, cardByRow, titleBySlug,
  onInsert, onInsertMany, onClose, onRequestMerge
}: {
  vRows: SearchResult[]
  activePos: number
  selected: Set<string>
  fullRows: SearchResult[]
  cardByRow: Map<SearchResult, DisplayCard>
  titleBySlug: Map<string, string>
  onInsert: (markdown: string, fromSlug: string, sourceOutlinePath: string) => void
  onInsertMany?: (items: { markdown: string; fromSlug: string; sourceOutlinePath: string }[]) => void
  onClose: () => void
  onRequestMerge?: (req: MergeRequest) => void
}) {
  // Build the host-mounted MergeConfirm's request from an identical cluster: occurrence-exact
  // targets over ALL copies, the distinct talks' display names, the copy count, and a title.
  function mergeRequestFromCluster(cluster: SlideCluster): MergeRequest {
    const talkTitles = cluster.kind === 'identical'
      ? cluster.talks.map((slug) => titleBySlug.get(slug) ?? slug)
      : []
    return {
      targets: mergeTargetsFromCluster(cluster),
      talkTitles,
      count: cluster.rows.length,
      title: rowTitle(cluster.rows[0] as SearchResult)
    }
  }
  function requestMerge(cluster: SlideCluster): void {
    if (!onRequestMerge || !clusterMergeable(cluster)) return
    onRequestMerge(mergeRequestFromCluster(cluster))
  }

  // What an insert hands the host, per row: the shared helper (SearchPalette uses the same one), which
  // reads a quick check's block from its talk so the copy keeps its {right}.
  // A second ⌘↵ while the outline read is pending must not insert the rows twice.
  const insertingRef = useRef(false)
  async function insertRows(rows: SearchResult[]): Promise<void> {
    if (rows.length === 0 || insertingRef.current) return
    insertingRef.current = true
    try {
      const items = await insertItemsFor(rows, (p) => window.tw.talk.readOutline(p))
      if (items.length > 1 && onInsertMany) onInsertMany(items)
      else items.forEach((it) => onInsert(it.markdown, it.fromSlug, it.sourceOutlinePath))
      onClose()
    } finally {
      insertingRef.current = false
    }
    // Insert-time merge nudge (Dominik's explicit ask): if any inserted slide is a byte-identical
    // stack of ≥2 that is not already one slide, offer to merge — non-blocking, one nudge, and the
    // action survives this close because it opens the host-mounted confirm.
    if (onRequestMerge) {
      const dupe = rows
        .map((r) => cardByRow.get(r))
        .find((c): c is DisplayCard => Boolean(c && c.kind === 'identical' && c.cluster && clusterMergeable(c.cluster)))
      if (dupe?.cluster) {
        const req = mergeRequestFromCluster(dupe.cluster)
        notify(mergeNudgeLabel(req.count - 1), 'info', 'merge-nudge', {
          label: 'Merge into one',
          onAction: () => onRequestMerge(req)
        })
      }
    }
  }
  function doInsert(): void {
    const chosen = selectedRowsFor(vRows, (pos) => selRowKey(vRows, pos), selected, fullRows)
    void insertRows(chosen.length > 0 ? chosen : (vRows[activePos] ? [vRows[activePos]] : []))
  }

  return { insertRows, doInsert, requestMerge }
}
