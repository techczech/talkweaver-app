import type { ReactNode } from 'react'
import { ConfirmCard, NameCard } from '../cards'

// The talk list's name prompt and destructive confirm (Electron blocks window.prompt/confirm). Both are
// now the one name card and the one confirm card (components/cards.tsx, house rule R10); these wrappers
// keep the talk list's call shape: structured fields first, a plain `label` for older callers.
// App imports PromptModal for New folder.

export function PromptModal({
  label,
  kind,
  mode,
  initial,
  cta,
  onCancel,
  onSubmit
}: {
  /** Older call sites: the whole question as one sentence; shown as the card heading. */
  label: string
  /** The thing being named ("talk", "folder"); with `mode` this makes the heading "New talk" / "Rename folder". */
  kind?: string
  mode?: 'new' | 'rename'
  initial: string
  cta: string
  onCancel: () => void
  onSubmit: (value: string) => void
}) {
  return (
    <NameCard
      kind={kind ?? label}
      mode={mode ?? 'new'}
      headingOverride={kind ? undefined : label}
      initial={initial}
      cta={cta}
      onCancel={onCancel}
      onSubmit={onSubmit}
    />
  )
}

export function ConfirmModal({
  label,
  title,
  itemName,
  consequence,
  recovery,
  cta,
  danger,
  children,
  onCancel,
  onConfirm
}: {
  /** Older call sites: the whole question as one sentence. */
  label: string
  title?: string
  itemName?: string
  consequence?: string
  recovery?: string
  cta: string
  danger?: boolean
  children?: ReactNode
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <ConfirmCard
      title={title ?? label}
      itemName={itemName}
      consequence={consequence}
      recovery={recovery}
      body={title ? undefined : <></>}
      cta={cta}
      danger={danger}
      enterConfirms
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      {children}
    </ConfirmCard>
  )
}
