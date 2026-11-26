import type { SlideMergeSide, SlideMergeStatus } from '../../../shared/outline-merge'
import type { SlideMergeReviewRow, SlideMergeSummary } from '../../../shared/outline-slide-merge'
import { notify } from '../lib/notify'

export const mergeSideName = { mine: 'This window', disk: 'On disk' }

export const mergeStatusLabel: Record<SlideMergeStatus, string> = {
  'changed-on-disk': 'Changed on disk',
  'changed-here': 'Changed in this window',
  'changed-in-both': 'Changed in both',
  'added-on-disk': 'New on disk',
  'added-here': 'New in this window',
  'removed-on-disk': 'Removed on disk',
  'removed-here': 'Removed in this window',
}

export function slideSourceLabel(row: SlideMergeReviewRow, side: SlideMergeSide, saved: string, disk: string): string {
  if (side === 'mine') {
    if (!row.mine) return row.base ? `Removed in this window since ${saved}` : 'Not in this window'
    if (!row.base) return `Added by you since ${saved}`
    return row.diskDiscardsWindowEdits ? `Edited by you since ${saved}` : `As saved at ${saved}`
  }
  if (!row.disk) return row.base ? `Removed at ${disk}` : 'Not in the file'
  if (!row.base) return `Added at ${disk}`
  return row.mineDiscardsDiskEdits ? `Changed at ${disk}` : `As saved at ${saved}`
}

export function slideChoiceWarning(row: SlideMergeReviewRow, side: SlideMergeSide): string | undefined {
  if (side === 'mine') {
    if (!row.mineDiscardsDiskEdits) return
    if (!row.base) return 'Discards the slide added on disk.'
    if (!row.disk) return 'Discards the removal made on disk.'
    if (!row.mine) return 'Discards this slide and the change made to it on disk.'
    return 'Discards the change made on disk to this slide.'
  }
  if (!row.diskDiscardsWindowEdits) return
  if (!row.base) return 'Discards your new slide.'
  if (!row.mine) return 'Discards your removal of this slide.'
  if (!row.disk) return 'Discards this slide and your edit to it.'
  return 'Discards your edit to this slide.'
}

export function mergeResultText({ mine, disk, both, removed }: SlideMergeSummary): string {
  return `${mine} from this window, ${disk} from disk, ${both} kept twice, ${removed} left out.`
}

export async function revealMergeArchive(path: string): Promise<boolean> {
  const missing = !await window.tw.shell.showInFolder(path).catch(() => false)
  if (missing) {
    notify('The recovery copy could not be opened. It may have expired.', 'warning', 'merge-archive')
  }
  return missing
}
