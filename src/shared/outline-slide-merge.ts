import type { SlideMergeChoices, SlideMergePlan, SlideMergeResult, SlideMergeRow } from './outline-merge.ts'

export interface SlideMergeReviewRow extends SlideMergeRow {
  mineDiscardsDiskEdits: boolean
  sections: Record<'base' | 'mine' | 'disk', string | null>
}

export interface SlideMergeReview extends Pick<SlideMergePlan, 'details' | 'order' | 'orders' | 'duplicateIds'> {
  rows: readonly SlideMergeReviewRow[]
  /** Opaque, window-bound. Only the most recent review for the current editor load can apply. */
  generation: string
  fileName: string
  lastSavedAt: number
  diskChangedAt: number
  /** Exact UTF-8 outline text for the three source panes. */
  sources: { base: string; mine: string; disk: string }
  unchanged: number
  recovery: { path: string; savedAt: number }
}

export interface SlideMergeSummary {
  mine: number
  disk: number
  both: number
  removed: number
  unchanged: number
  total: number
  unresolved: string[]
}

export type SlideMergeFailure =
  | Extract<SlideMergeResult, { ok: false }>
  | { ok: false; reason: 'ownership' | 'no-conflict' | 'stale-plan' | 'stale-disk' | 'window-changed' | 'recovery-failed' | 'save-failed'; error: string }

export type SlideMergeReviewReply = ({ ok: true } & SlideMergeReview) | SlideMergeFailure
export type SlideMergeApplyReply = { ok: true; summary: SlideMergeSummary; savedAt: number } | SlideMergeFailure

/** Preview the result as choices change. Missing details/order choices also prevent Apply. */
export function summarizeSlideMerge(review: SlideMergeReview, choices: SlideMergeChoices): SlideMergeSummary {
  const summary: SlideMergeSummary = {
    mine: 0, disk: 0, both: 0, removed: 0, unchanged: review.unchanged, total: review.unchanged, unresolved: [],
  }
  const selected = (row: { key: string; defaultChoice?: 'mine' | 'disk' }) =>
    Object.hasOwn(choices, row.key) ? choices[row.key] : row.defaultChoice
  for (const row of review.rows) {
    const choice = selected(row)
    if (!choice || (choice === 'both' && (!row.mine || !row.disk))) {
      summary.unresolved.push(row.key)
    } else if (choice === 'both') {
      summary.both++
      summary.total += 2
    } else if (!row[choice]) {
      summary.removed++
    } else {
      summary[choice]++
      summary.total++
    }
  }
  for (const row of [review.details, review.order]) {
    if (row && (!selected(row) || selected(row) === 'both')) summary.unresolved.push(row.key)
  }
  return summary
}
