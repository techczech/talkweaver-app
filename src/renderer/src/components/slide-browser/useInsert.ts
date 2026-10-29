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
import type { ScratchSlideInput } from '../../../../shared/scratchpad'
import type { SearchResult } from './types'

export function useInsert({
  vRows, activePos, selected, fullRows, cardByRow, titleBySlug,
  onInsert, onInsertMany, onClose, onRequestMerge, vaultRoot, onAddedToScratchpad
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
  /** The open vault's root: a slide's talk is stored relative to it when it sits inside. */
  vaultRoot: string
  /** Called after slides were added, so the browser can clear its selection. */
  onAddedToScratchpad?: () => void
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

  // Add N to Slide Scratchpad: the same markdown an insert would prepare (insertItemsFor, so a quick check keeps its
  // {right}), stored as a snapshot beside where it came from. The outline is not touched; the browser stays open.
  const addingRef = useRef(false)
  async function addRowsToScratchpad(rows: SearchResult[]): Promise<void> {
    if (rows.length === 0 || addingRef.current) return
    addingRef.current = true
    try {
      const items = await insertItemsFor(rows, (p) => window.tw.talk.readOutline(p))
      const inputs: ScratchSlideInput[] = rows.map((row, i) => ({
        talkPath: relativeToVault(row.outlinePath, vaultRoot),
        talkTitle: row.talkTitle,
        slideId: row.slide_id,
        title: rowTitle(row),
        markdown: items[i].markdown,
        thumbKey: row.render_hash || row.content_hash,
        talkSlug: row.talkSlug,
        ...(row.vaultId ? { vaultId: row.vaultId } : {})
      }))
      const reply = await window.tw.scratchpad.addSlides(inputs)
      if (!reply.ok) { notify(reply.error, 'warning', 'scratchpad-add'); return }
      const said = reply.added === 1 ? 'Added 1 slide to Slide Scratchpad' : `Added ${reply.added} slides to Slide Scratchpad`
      notify(reply.skipped > 0 ? `${said}. ${reply.skipped} already there.` : said, 'info', 'scratchpad-add')
      onAddedToScratchpad?.()
    } catch (error) {
      notify(error instanceof Error ? error.message : 'The slides could not be added to the Slide Scratchpad.', 'warning', 'scratchpad-add')
    } finally {
      addingRef.current = false
    }
  }
  /** The selected rows (or the focused one) go to the Scratchpad; false when there is nothing to add. */
  function doAddToScratchpad(): boolean {
    const chosen = selectedRowsFor(vRows, (pos) => selRowKey(vRows, pos), selected, fullRows)
    const rows = chosen.length > 0 ? chosen : (vRows[activePos] ? [vRows[activePos]] : [])
    if (rows.length === 0) return false
    void addRowsToScratchpad(rows)
    return true
  }

  return { insertRows, doInsert, requestMerge, doAddToScratchpad }
}

/** The talk's outline path relative to the vault root, or as it is when the talk sits outside that vault. */
export function relativeToVault(outlinePath: string, vaultRoot: string): string {
  const root = vaultRoot.endsWith('/') ? vaultRoot : `${vaultRoot}/`
  return vaultRoot && outlinePath.startsWith(root) ? outlinePath.slice(root.length) : outlinePath
}
