// Insert (contract identical to SearchPalette) and the duplicate merge it can nudge towards.
import { notify } from '../../lib/notify'
import {
  type DisplayCard, type MergeRequest, type SlideCluster,
  clusterMergeable, mergeNudgeLabel, mergeTargetsFromCluster, selRowKey
} from '../slideBrowserModel'
import { selectedRowsFor } from '../talkBesideModel'
import { insertItemsFor, rowTitle } from './browserHelpers'
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

  function insertRows(rows: SearchResult[]): void {
    const items = insertItemsFor(rows)
    if (items.length === 0) return
    if (items.length > 1 && onInsertMany) onInsertMany(items)
    else items.forEach((it) => onInsert(it.markdown, it.fromSlug, it.sourceOutlinePath))
    onClose()
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
    insertRows(chosen.length > 0 ? chosen : (vRows[activePos] ? [vRows[activePos]] : []))
  }

  return { insertRows, doInsert, requestMerge }
}
