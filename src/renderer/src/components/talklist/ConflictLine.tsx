import type { TalkInfo } from '../../../../preload/index'

// The amber conflict line on a talk row (several-vaults ticket 09; LOCKED-sidebar section 4,
// LOCKED-conflict frame 1): "1 conflict copy · Compare…", counted when there are several.
// Compare… raises the `tw:conflict-compare` window event (detail: { outlinePath, vaultId }); App opens
// the compare screen for it (ticket 10, ConflictCompare.tsx). It never writes anything itself.

export const CONFLICT_COMPARE_EVENT = 'tw:conflict-compare'

export function conflictLabel(count: number): string {
  return `${count} conflict ${count === 1 ? 'copy' : 'copies'}`
}

export default function ConflictLine({ talk, className = 'tl-row-sub tl-row-conflict' }: { talk: TalkInfo; className?: string }) {
  const count = talk.conflicts ?? 0
  if (count <= 0) return null
  return (
    <span className={className} data-conflict-count={count} title={`${conflictLabel(count)} of this talk's outline, made by a sync service`}>
      {conflictLabel(count)} · <span
        className="tl-row-conflict-compare"
        role="button"
        tabIndex={-1}
        data-conflict-compare
        onClick={(e) => {
          e.stopPropagation()
          window.dispatchEvent(new CustomEvent(CONFLICT_COMPARE_EVENT, { detail: { outlinePath: talk.outlinePath, vaultId: talk.vaultId } }))
        }}
      >Compare…</span>
    </span>
  )
}
