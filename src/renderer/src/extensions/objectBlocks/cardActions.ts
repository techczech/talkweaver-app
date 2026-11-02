// An object card's header actions (ADR-0042 completion): Open, Reveal, Capture embed, Place earlier views,
// Copy markup, Replace file and Remove. The app's own channels do the outside work (cardActionHost,
// provided by the editor): Open and Reveal go through shell:open-path / shell:show-item-in-folder, which check the path again at that moment,
// so the card's file status is never what allows them; a web address opens through shell:open-external.
// Replace file runs the HTML page picker and copy main already has (talk-scoped tokens), then writes the
// new reference into the card's line, planned against the text as it is when the copy is back. Remove and
// Replace are each one change, one undo step; a cancelled picker writes nothing. Capture embed opens the
// capture window for this card's page on this card's slide; Place earlier views writes the page's
// earlier saved views (main reads them) under this card, one undo step.
//
// Replace and Place earlier views wait on main before they write (review R2 of a222975a). The card is
// held from the click: its range is mapped through every change made meanwhile, and any change inside
// it (an edit, a deletion, retyping the same bytes) lets go of it. The write goes only to the held range
// with its bytes unchanged; an identical card elsewhere is never taken for it.
import { isolateHistory } from '@codemirror/commands'
import { Facet, StateEffect, StateField, type ChangeDesc } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { locateCard, planCardFileReplace, planCardRemoval, planPlaceEarlierViews, type CardRef } from '../../../../shared/objects/card-actions.ts'
import { slideAround } from '../../../../shared/objects/notes-planner.ts'
import { captureMarkupLine, embedLinePageUrl } from '../../../../../compiler/scripts/lib/live-page-capture-markup.mjs'
import { notify } from '../../lib/notify.ts'
import type { ObjectBlock } from './detect.ts'
import { objectStatusField } from './status.ts'

export type CardActionHost = {
  openPath?: (path: string) => Promise<boolean>
  showInFolder?: (path: string) => Promise<boolean>
  openExternal?: (url: string) => Promise<boolean>
  copyText?: (text: string) => Promise<void> | void
  /**
   * Pick and copy a replacement page into the open talk: the reference to write and what to say once it
   * is written, or null (cancelled; a refusal has been said).
   */
  chooseReplacementPage?: () => Promise<{ ref: string; note: string; warn: boolean } | null>
  /** Capture embed… for this page on the slide whose heading is on `headingLine` (1-based). */
  captureEmbed?: (headingLine: number, pageUrl: string) => void
  /** The page's views saved before {capture} lines existed, from main; null when they could not be read. */
  earlierViews?: (pageUrl: string) => Promise<Array<{ image: string; capturedAt: string; mode?: 'page' }> | null>
}

export const cardActionHost = Facet.define<CardActionHost, CardActionHost>({
  combine: (values) => Object.assign({}, ...values)
})

export type CardAction = 'open' | 'reveal' | 'capture' | 'place-earlier' | 'copy' | 'replace' | 'remove'

const LOCAL = new Set(['local', 'simulation', 'video'])
const WEB = new Set(['web', 'bare', 'video-web'])

/** The actions a card offers, in header order. */
export function cardActionsFor(block: ObjectBlock, host: CardActionHost): CardAction[] {
  const actions: CardAction[] = []
  const variant = block.embed?.variant
  if (variant && (LOCAL.has(variant) ? host.openPath : WEB.has(variant) && host.openExternal)) actions.push('open')
  if (variant && LOCAL.has(variant) && host.showInFolder) actions.push('reveal')
  if (cardPageUrl(block)) {
    if (host.captureEmbed) actions.push('capture')
    if (host.earlierViews && !block.embed?.marker && !block.embed?.captures.length) actions.push('place-earlier')
  }
  if (host.copyText) actions.push('copy')
  if ((variant === 'local' || variant === 'simulation') && host.chooseReplacementPage) actions.push('replace')
  actions.push('remove')
  return actions
}

export const CARD_ACTION_LABELS: Readonly<Record<CardAction, { glyph: string; title: string }>> = {
  open: { glyph: '↗', title: 'Open' },
  reveal: { glyph: '⌕', title: 'Show in Finder' },
  capture: { glyph: '◎', title: 'Capture embed…' },
  'place-earlier': { glyph: '⤓', title: 'Place earlier views on this slide' },
  copy: { glyph: '⧉', title: 'Copy markup' },
  replace: { glyph: '⇄', title: 'Replace file…' },
  remove: { glyph: '×', title: 'Remove from slide (Undo restores it)' }
}

/** The web page address a card's page line embeds (as saved views key it), or null. */
export function cardPageUrl(block: ObjectBlock): string | null {
  const variant = block.embed?.variant
  if (variant !== 'web' && variant !== 'bare') return null
  return embedLinePageUrl(block.source.split('\n')[0].replace(/\r$/, '').trim())
}

const cardRef = (block: ObjectBlock): CardRef => ({ from: block.from, to: block.to, source: block.source })

/** A held card's range after `changes`, or null when a change touched its bytes. */
export function mapHeldCard(card: CardRef, changes: ChangeDesc): CardRef | null {
  let touched = false
  changes.iterChangedRanges((fromA, toA) => { if (fromA < card.to && toA > card.from) touched = true })
  if (touched) return null
  return { from: changes.mapPos(card.from, 1), to: changes.mapPos(card.to, -1), source: card.source }
}

const holdCard = StateEffect.define<{ id: number; card: CardRef }>()
const releaseCard = StateEffect.define<number>()
/** Cards held while an action waits: id → range now, or null once the card was changed or deleted. */
const heldCards = StateField.define<ReadonlyMap<number, CardRef | null>>({
  create: () => new Map(),
  update(held, tr) {
    if (!held.size && !tr.effects.length) return held
    const next = new Map<number, CardRef | null>()
    for (const [id, card] of held) next.set(id, card && tr.docChanged ? mapHeldCard(card, tr.changes) : card)
    for (const effect of tr.effects) {
      if (effect.is(holdCard)) next.set(effect.value.id, effect.value.card)
      if (effect.is(releaseCard)) next.delete(effect.value)
    }
    return next
  }
})
let nextHold = 1

/** Hold the card where it is now; null when it is not in the text as drawn. */
function hold(view: EditorView, block: ObjectBlock): number | null {
  const at = locateCard(view.state.doc.toString(), cardRef(block))
  if (!at) return null
  const id = nextHold++
  const effects: StateEffect<unknown>[] = [holdCard.of({ id, card: at })]
  if (!view.state.field(heldCards, false)) effects.unshift(StateEffect.appendConfig.of(heldCards))
  view.dispatch({ effects })
  return id
}
/** The held card now, only if its bytes are still at its mapped place. */
function heldNow(view: EditorView, id: number): CardRef | null {
  const card = view.state.field(heldCards, false)?.get(id) ?? null
  return card && view.state.doc.sliceString(card.from, card.to) === card.source ? card : null
}
function release(view: EditorView, id: number): void {
  try { view.dispatch({ effects: releaseCard.of(id) }) } catch { /* the editor is gone */ }
}

function write(view: EditorView, change: { from: number; to: number; insert: string }, userEvent: string): void {
  view.dispatch({
    changes: change,
    selection: { anchor: change.from },
    userEvent,
    annotations: isolateHistory.of('full'),
    scrollIntoView: true
  })
}

/** Run one header action on the card as it was drawn. Resolves when its outside work is done. */
export async function runCardAction(view: EditorView, block: ObjectBlock, action: CardAction): Promise<void> {
  const host = view.state.facet(cardActionHost)
  const src = block.embed?.src ?? ''
  if (action === 'copy') {
    await host.copyText?.(block.source.replace(/\r?\n$/, ''))
    notify('Markup copied.', 'success', 'card-copy')
    return
  }
  if (action === 'remove') {
    const plan = planCardRemoval(view.state.doc.toString(), cardRef(block))
    if (!plan.ok) { notify(plan.reason, 'warning', 'card-remove'); return }
    write(view, plan.change, 'delete.object')
    return
  }
  if (action === 'capture') {
    const pageUrl = cardPageUrl(block)
    const text = view.state.doc.toString()
    const slide = slideAround(text, view.state.doc.lineAt(Math.min(block.from, view.state.doc.length)).number - 1)
    if (!pageUrl || !slide) { notify('This page is not on a slide yet, so there is nothing to capture for.', 'info', 'capture-embed'); return }
    host.captureEmbed?.(slide.heading + 1, pageUrl)
    return
  }
  if (action === 'place-earlier') {
    const pageUrl = cardPageUrl(block)
    if (!pageUrl || !host.earlierViews) return
    const id = hold(view, block)
    if (id === null) { notify(CARD_GONE, 'warning', 'capture-embed'); return }
    try {
      const views = await host.earlierViews(pageUrl)
      if (!views) { notify('The earlier saved views could not be read, so nothing was placed.', 'warning', 'capture-embed'); return }
      if (!views.length) { notify('This page has no earlier saved views.', 'info', 'capture-embed'); return }
      const card = heldNow(view, id)
      if (!card) { notify(`${CARD_GONE} Nothing was placed.`, 'warning', 'capture-embed'); return }
      const lines = views.map((v) => captureMarkupLine(v.image, v.capturedAt, v.mode === 'page' ? 'page' : 'view'))
      const plan = planPlaceEarlierViews(view.state.doc.toString(), card, pageUrl, lines)
      if (!plan.ok) { notify(plan.reason, 'warning', 'capture-embed'); return }
      write(view, plan.change, 'input.capture')
      notify(`Placed ${views.length} earlier saved view${views.length === 1 ? '' : 's'} on this slide. Undo takes them off again.`, 'success', 'capture-embed')
    } finally { release(view, id) }
    return
  }
  if (action === 'open' || action === 'reveal') {
    if (block.embed && WEB.has(block.embed.variant)) {
      if (!(await host.openExternal?.(src))) notify('This address could not be opened.', 'warning', 'card-open')
      return
    }
    const status = view.state.field(objectStatusField, false)?.get(src)
    if (!status?.path || status.state !== 'present') {
      notify(status?.state === 'outside' ? 'This file is outside the talk’s vault, so it is not opened from here.'
        : status?.state === 'missing' ? 'File not found.' : 'The file is still being checked. Try again in a moment.', 'warning', 'card-open')
      return
    }
    const done = action === 'open' ? await host.openPath?.(status.path) : await host.showInFolder?.(status.path)
    if (!done) notify(action === 'open' ? 'The file could not be opened.' : 'The file could not be shown.', 'warning', 'card-open')
    return
  }
  // Replace file…: the picker and the copy are main's; the line is planned when the copy is back.
  if (!host.chooseReplacementPage) return
  const id = hold(view, block)
  if (id === null) { notify(CARD_GONE, 'warning', 'card-replace'); return }
  try {
    const chosen = await host.chooseReplacementPage()
    if (!chosen) return
    const card = heldNow(view, id)
    const plan = card ? planCardFileReplace(view.state.doc.toString(), card, chosen.ref) : { ok: false as const, reason: CARD_GONE }
    if (!plan.ok) { notify(`${plan.reason} The new page is in the talk’s folder as ${chosen.ref}.`, 'warning', 'card-replace'); return }
    write(view, plan.change, 'input.replace')
    notify(`Page replaced with ${chosen.ref}. ${chosen.note}`, chosen.warn ? 'warning' : 'success', 'card-replace')
  } finally { release(view, id) }
}

const CARD_GONE = 'The card was changed or removed while this was waiting, so nothing was written to it.'
