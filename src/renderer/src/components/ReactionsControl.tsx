// The Inspector's Audience › Reactions group (ticket 04; round-2 drawings I1–I4): Standard · Choose ·
// Custom · Off. Every action writes exactly one {reactions=…} token (Standard writes none) through
// the group's ordinary commit path; the Trigger line stays the truth. The model is
// reactionsControlModel.ts; this file only draws it and remembers a mode opened but not yet written.
import React, { useState } from 'react'
import {
  Bookmark, Check, Frown, Info, Lightbulb, MessageCircleMore, Snail, ThumbsDown, ThumbsUp, X, type LucideIcon
} from 'lucide-react'
import type { OptionGroup } from '../data/layouts'
import {
  MAX_REACTIONS, STANDARD_REACTIONS, reactionsChipToken, reactionsControlView, reactionsLabelsToken,
  reactionsModeToken, registeredReactions, type ReactionsMode
} from './reactionsControlModel'

const ICONS: Record<string, LucideIcon> = {
  frown: Frown, lightbulb: Lightbulb, bookmark: Bookmark, 'thumbs-up': ThumbsUp, 'thumbs-down': ThumbsDown,
  check: Check, x: X, 'message-circle-more': MessageCircleMore, snail: Snail
}
const MODES: ReadonlyArray<{ mode: ReactionsMode; label: string; description: string }> = [
  { mode: 'standard', label: 'Standard', description: 'Puzzled by this, Helped me understand and Bookmark' },
  { mode: 'choose', label: 'Choose', description: 'Up to four of the registered reactions' },
  { mode: 'custom', label: 'Custom', description: 'Up to four labels of your own, shown in words' },
  { mode: 'off', label: 'Off', description: 'No reactions on this slide; Ask stays' }
]

function ReactionIcon({ name }: { name: string }): React.JSX.Element | null {
  const Icon = ICONS[name]
  return Icon ? <Icon aria-hidden /> : null
}

export default function ReactionsControl({ group, selectedToken, onSelect }: {
  group: OptionGroup
  selectedToken: string
  onSelect: (group: OptionGroup, token: string) => void
}): React.JSX.Element {
  // Choose or Custom opened with nothing written yet: shown, not written. A write re-keys this
  // component (the Inspector keys it by slide and token), so the pending mode never outlives it.
  const [pending, setPending] = useState<ReactionsMode | null>(null)
  const [problem, setProblem] = useState('')
  const view = reactionsControlView(selectedToken, pending)
  const registry = registeredReactions()
  const write = (token: string | null): void => {
    if (token === null) return
    if (token === selectedToken) return
    onSelect(group, token)
  }
  const chooseMode = (mode: ReactionsMode): void => {
    setProblem('')
    const token = reactionsModeToken(mode)
    if (token === null) { setPending(mode === view.mode && !pending ? null : mode); return }
    setPending(null)
    write(token)
  }
  const commitLabels = (input: HTMLInputElement): void => {
    if (input.value === input.defaultValue) return
    const result = reactionsLabelsToken(input.value)
    if (result.problem) { setProblem(result.problem); return }
    setProblem('')
    write(result.token ?? '')
  }

  return (
    <div className="layout-option-control tw-reactions-control">
      <div className="layout-option-segments" role="group" aria-label={group.label}>
        {MODES.map(({ mode, label, description }) => (
          <button
            key={mode}
            type="button"
            className={view.mode === mode ? 'is-selected' : undefined}
            aria-pressed={view.mode === mode}
            title={description}
            onClick={() => chooseMode(mode)}
          ><span>{label}</span></button>
        ))}
      </div>

      {view.mode === 'standard' && (
        <>
          <div className="tw-reactions-standard">
            {STANDARD_REACTIONS.map((id) => {
              const entry = registry.find((candidate) => candidate.id === id)
              return entry ? <span key={id}><ReactionIcon name={entry.icon} />{entry.short}</span> : null
            })}
          </div>
          <p className="tw-reactions-note"><Info aria-hidden />Every slide offers these unless it says otherwise. The phone shows them under the slide with Ask.</p>
        </>
      )}

      {view.mode === 'choose' && (
        <>
          <div className="tw-reactions-chips" role="group" aria-label="Reactions on this slide">
            {registry.map((entry) => {
              const at = view.chosen.indexOf(entry.id)
              const full = at < 0 && view.chosen.length >= MAX_REACTIONS
              return (
                <button
                  key={entry.id}
                  type="button"
                  className={at >= 0 ? 'is-selected' : undefined}
                  aria-pressed={at >= 0}
                  disabled={full}
                  title={full ? `Up to ${MAX_REACTIONS} reactions on a slide` : entry.words}
                  onClick={() => { setProblem(''); write(reactionsChipToken(view.chosen, entry.id)) }}
                >
                  <ReactionIcon name={entry.icon} />
                  <span className="tw-reactions-chip-label">{entry.short}</span>
                  {at >= 0 && <span className="tw-reactions-chip-order" aria-label={`chosen ${at + 1}`}>{at + 1}</span>}
                </button>
              )
            })}
          </div>
          <p className="tw-reactions-note"><Info aria-hidden />Up to four, in the order chosen. Bookmark stays only if you choose it.</p>
        </>
      )}

      {view.mode === 'custom' && (
        <>
          <input
            key={selectedToken}
            className="tw-reactions-labels"
            type="text"
            aria-label="Custom reaction labels, separated by commas"
            placeholder="Too fast, Just right, Too slow"
            defaultValue={view.labelsText}
            onBlur={(event) => commitLabels(event.currentTarget)}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === 'Enter') { event.preventDefault(); commitLabels(event.currentTarget) }
            }}
          />
          {problem && <p className="tw-reactions-problem" role="alert">{problem}</p>}
          <p className="tw-reactions-note"><Info aria-hidden />Up to four, separated by commas. Shown in words on the phone, with no icon.</p>
        </>
      )}

      {view.mode === 'off' && (
        <p className="tw-reactions-note"><Info aria-hidden />No reactions on this slide. The phone still shows Ask, and questions still arrive.</p>
      )}

      {view.token && (
        <p className="tw-reactions-token">Trigger line <code>{`{${view.token}}`}</code></p>
      )}
    </div>
  )
}
