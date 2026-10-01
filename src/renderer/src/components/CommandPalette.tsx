// The option controls the Inspector draws (segments, thumbnails, number and reactions controls).
// This file used to hold the ⌘L layout palette too; ADR-0032 moved the picker into the Inspector's
// column (LayoutPickerColumn.tsx) and removed that palette, its inline variant rows and its Type strip.
import PollAuthoringHelp from './PollAuthoringHelp'
import ReactionsControl from './ReactionsControl'
import React from 'react'
import { type LayoutDef, type OptionGroup, type OptionValue } from '../data/layouts'
import { type PickerOptionGroup } from './layoutPickerModel'

function optionThumbKind(entry: LayoutDef, token: string): string | null {
  const key = `${entry.name}:${token || 'default'}`
  const kinds: Record<string, string> = {
    'contrast:default': 'contrast-default',
    'contrast:contrast=ledger': 'contrast-ledger',
    'contrast:contrast=rows': 'contrast-rows',
    'contrast:contrast=tint': 'contrast-tint',
    'contrast:contrast=flip': 'contrast-flip',
    'cards:default': 'cards-grid',
    'cards:cards=grid': 'cards-grid',
    'cards:cards=rows': 'cards-rows',
    'cards:cards=stepped': 'cards-stepped'
  }
  return kinds[key] ?? null
}

export function OptionThumb({ entry, token }: { entry: LayoutDef; token: string }): React.JSX.Element {
  const kind = optionThumbKind(entry, token)
  return (
    <span className={`layout-option-thumb${kind ? ` layout-option-thumb--${kind}` : ' layout-option-thumb--neutral'}`}>
      <i /><i /><i /><i /><i /><i />
    </span>
  )
}

export function OptionControl({
  entry,
  binding,
  onSelect,
  deckToken,
  values: offeredValues
}: {
  entry?: LayoutDef
  binding: PickerOptionGroup
  onSelect: (group: OptionGroup, token: string) => void
  /** T32 (Decision 1A): the value the DECK makes; that button carries the small “deck” mark. */
  deckToken?: string
  /** ADR-0028 §10: the values this slide offers, when a caller filtered them; else every value. */
  values?: OptionValue[]
}): React.JSX.Element {
  const { group, selectedToken } = binding
  const values = offeredValues ?? group.values
  // Ticket 04: the slide's reactions — Standard · Choose · Custom · Off, one {reactions=…} token.
  if (group.reactionsKey) return <ReactionsControl group={group} selectedToken={selectedToken} onSelect={onSelect} />
  if (group.numberKey) {
    const value = selectedToken.startsWith(group.numberKey + '=') ? selectedToken.split('=')[1] : ''
    const commit = (input: HTMLInputElement): void => {
      if (input.value === input.defaultValue) return
      if (!input.value) onSelect(group, '')
      else if (input.validity.valid && Number.isSafeInteger(Number(input.value))) onSelect(group, `${group.numberKey}=${Number(input.value)}`)
      else input.reportValidity()
    }
    return <div className="layout-option-segments" role="group" aria-label={group.label}>
      <input key={selectedToken} type="number" min="1" step="1" aria-label={group.label}
        defaultValue={value === 'unlimited' ? '' : value} placeholder={group.numberKey === 'pollsubmissions' ? '1' : 'All'}
        style={{ width: '5rem' }} onBlur={(event) => commit(event.currentTarget)}
        onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); commit(event.currentTarget) } }} />
      {group.values.map((option) => <button key={option.token} type="button" aria-pressed={selectedToken === option.token}
        onClick={() => onSelect(group, option.token)}>{option.label}</button>)}
      {group.allowUnlimited && <button type="button" aria-pressed={value === 'unlimited'} onClick={() => onSelect(group, `${group.numberKey}=unlimited`)}>Unlimited</button>}
    </div>
  }
  const isThumbs = group.preview === 'thumbs' && entry != null
  const moveWithinGroup = (event: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      onSelect(group, values[index].token)
      return
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    event.stopPropagation()
    const nextIndex = (index + (event.key === 'ArrowRight' ? 1 : -1) + values.length) % values.length
    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')
    buttons?.[nextIndex]?.focus()
  }

  return (
    <div className="layout-option-control">
    <div className={isThumbs ? 'layout-option-thumbs' : 'layout-option-segments'} role="group" aria-label={group.label}
      data-deck-mark={deckToken !== undefined ? 'true' : undefined}>
      {values.map((value, index) => {
        const selected = value.token === selectedToken
        const deckMarked = deckToken !== undefined && deckToken === value.token
        return (
          <button
            key={`${group.key}:${value.token || 'default'}`}
            type="button"
            className={selected ? 'is-selected' : undefined}
            aria-pressed={selected}
            title={value.description}
            tabIndex={selected || (!values.some((candidate) => candidate.token === selectedToken) && index === 0) ? 0 : -1}
            onClick={() => onSelect(group, value.token)}
            onKeyDown={(event) => moveWithinGroup(event, index)}
          >
            {isThumbs && <OptionThumb entry={entry} token={value.token} />}
            {value.swatch && <span className="layout-option-swatch" style={{ background: value.swatch }} aria-hidden />}
            <span>{value.label}</span>
            {deckMarked && <span className="layout-option-deck-mark" title="The deck's own choice for this slide">deck</span>}
          </button>
        )
      })}
    </div>
    {group.key === 'poll-type' && <PollAuthoringHelp token={selectedToken} />}
    </div>
  )
}
