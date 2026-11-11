import type { ReactNode } from 'react'
import type { PillKind } from '../../../shared/run-checklist'
import '../ui-kit.css'

// The one badge (house rule R15): a fixed colour per state, whichever view shows it. The label is the caller's words
// ("Published", "Live now", "Delivered"); the colour is the state's.
export type BadgeState = 'planned' | 'published' | 'delivered' | 'live' | 'notset'

/** The words a state wears when the caller has none of its own. */
export const BADGE_LABELS: Record<BadgeState, string> = { planned: 'Planned', published: 'Published', delivered: 'Delivered', live: 'Live now', notset: 'Not set up' }

/** The badge state a Run checklist pill stands for (run-checklist.ts keeps its own colour names). */
export function badgeStateOfPill(kind: PillKind): BadgeState {
  return kind === 'green' ? 'published' : kind === 'red' ? 'live' : kind === 'amber' ? 'notset' : kind === 'blue' ? 'delivered' : 'planned'
}

export function StateBadge({ state, children, small, dot, ...rest }: { state: BadgeState; children?: ReactNode; small?: boolean; dot?: boolean } & Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'>): JSX.Element {
  return (
    <span {...rest} className={`tw-badge${small ? ' tw-badge--sm' : ''}${rest.className ? ` ${rest.className}` : ''}`} data-state={state}>
      {(dot || state === 'live') && <span className="tw-badge-dot" aria-hidden />}{children ?? BADGE_LABELS[state]}
    </span>
  )
}
