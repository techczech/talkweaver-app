// Compact object cards (ADR-0042, Shape A): every fence that is not a drawable object, speaker notes and
// standalone HTML comments. A card is one line of what the object is; ⌄ expands a bounded, read-only
// preview (session chrome, never written); `</>` shows the exact source. Every piece of author text is
// set with textContent. Local page previews load into a scriptless, network-free frame.
import { Facet } from '@codemirror/state'
import { type EditorView, WidgetType } from '@codemirror/view'
import { splitSegments } from '../../../../../compiler/scripts/lib/simulation-segments.mjs'
import {
  cardKind,
  EMBED_LABELS,
  NOTES_PRIVACY_TEXT,
  SIMULATION_DESIGN_LABELS
} from '../../../../shared/objects/card-kinds.ts'
import { objectBlockEditableSource, type InlineComment, type ObjectBlock } from './detect.ts'
import { exactTextWrite, setExpandedObjectBlock, setOpenObjectBlock, setRawObjectBlock } from './effects.ts'
import { ObjectWidget } from './widgets.ts'
import { cardPreviewKind, showPagePreview, simulationPreview, type CardPreviewKind } from './previews.ts'
import { cardFileNote, cardStatusRefs, type CardFileStatus } from './status.ts'
import { CARD_ACTION_LABELS, cardActionHost, cardActionsFor, runCardAction } from './cardActions.ts'
import { planNotesClose } from '../../../../shared/objects/notes-planner.ts'
import { notify } from '../../lib/notify.ts'
import { notesMoveHandle } from './notesDrag.ts'

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function nonBlankLines(text: string): string[] {
  return text.split('\n').map((line) => line.replace(/\r$/, '')).filter((line) => line.trim() !== '')
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

/** What the compact line and the chips of a card say: computed from the source only. */
export function cardSummary(block: ObjectBlock): { title: string; detail: string; chips: string[]; first?: string; mono?: boolean } {
  const body = objectBlockEditableSource(block)
  const declaration = cardKind(block.kind)
  const label = declaration?.label ?? block.kind
  if (block.kind === 'notes') {
    const words = wordCount(body)
    const position = block.deckNotes
      ? 'whole talk'
      : (block.notesCount ?? 1) > 1 ? `${block.notesIndex} of ${block.notesCount} · the deck joins all blocks on this slide` : ''
    return {
      title: label,
      detail: [body.trim() ? plural(words, 'word') : 'empty', position].filter(Boolean).join(' · '),
      chips: ['Presenter only'],
      first: nonBlankLines(body)[0]
    }
  }
  if (block.kind === 'embed' && block.embed) {
    const facts = block.embed
    const words = EMBED_LABELS[facts.variant] ?? { label: 'Page', status: '' }
    const views = facts.variant === 'web' || facts.variant === 'bare'
      ? facts.captures.length ? plural(facts.captures.length, 'saved view') : facts.marker ? 'no saved views' : 'no saved views on the slide'
      : ''
    return {
      title: words.label,
      detail: [facts.name, views].filter(Boolean).join(' · '),
      chips: [words.status, ...(facts.playOnNext ? ['plays on next'] : [])].filter(Boolean)
    }
  }
  if (block.kind === 'comment') {
    const description = block.comment
    return {
      title: label,
      detail: description?.label.replace(/^Comment · /, '') ?? '',
      chips: description?.effect === 'deck' ? ['changes the deck'] : description?.effect === 'hides' ? ['hides slides'] : ['not shown anywhere']
    }
  }
  if (block.kind === 'chat') {
    const split = splitSegments('turns', body)
    const roles = split.rows.map((row) => row.role)
    const parts: string[] = [plural(split.rows.length, 'turn')]
    if (roles.includes('model-reasoning')) parts.push('reasoning')
    const calls = roles.filter((role) => role === 'tool-call').length
    if (calls) parts.push(plural(calls, 'tool call'))
    const user = split.rows.find((row) => row.role === 'user')
    return {
      title: label,
      detail: parts.join(' · '),
      chips: [SIMULATION_DESIGN_LABELS[block.design ?? 'chat'] ?? 'AI chat'],
      first: user ? `user  ${user.content.split('\n')[0]}` : undefined
    }
  }
  if (block.kind === 'terminal') {
    const split = splitSegments('shell', body)
    const commands = split.rows.filter((row) => row.command)
    return {
      title: label,
      detail: plural(commands.length, 'command'),
      chips: [SIMULATION_DESIGN_LABELS.terminal],
      first: commands[0] ? `$ ${commands[0].command}` : undefined,
      mono: true
    }
  }
  if (block.kind === 'trace') {
    const split = splitSegments('trace', body)
    return { title: label, detail: plural(split.rows.length, 'turn'), chips: [], first: split.rows[0]?.header, mono: true }
  }
  const lines = body === '' ? 0 : body.split('\n').length
  const chips: string[] = [block.info?.trim() ? `language: ${block.info.trim()}` : 'plain text']
  if (block.simNote === 'ignored') chips.push('ignored by this chat slide')
  if (block.simNote === 'other-layout') chips.push('shown as code on this slide')
  if (/<!--[\s\S]*?-->/.test(body)) chips.push('a comment inside is removed in the deck')
  return { title: label, detail: plural(lines, 'line'), chips, first: nonBlankLines(body)[0], mono: true }
}

/** Rows of the read-only expanded preview. */
function expandedRows(block: ObjectBlock): Array<{ label: string; text: string }> {
  const body = objectBlockEditableSource(block)
  if (block.kind === 'chat') {
    return splitSegments('turns', body).rows.map((row) => ({
      label: row.duration !== null ? `${row.role} (${row.duration})` : row.role,
      text: row.content
    }))
  }
  if (block.kind === 'terminal') {
    return splitSegments('shell', body).rows.map((row) => ({
      label: `${row.path ? `${row.path} ` : ''}$`,
      text: [row.command, row.output].filter(Boolean).join('\n')
    }))
  }
  if (block.kind === 'trace') {
    return splitSegments('trace', body).rows.map((row) => ({ label: row.header, text: row.content }))
  }
  if (block.kind === 'comment') {
    return [
      { label: 'Text', text: block.source.replace(/\r?\n$/, '') },
      { label: 'What it is', text: block.comment?.explanation ?? '' }
    ]
  }
  if (block.kind === 'embed' && block.embed) {
    return [
      { label: 'Address', text: block.embed.src },
      ...(block.embed.marker ? [{ label: 'Marker', text: 'Saved views for this page are the lines below. Deleting the whole card removes them all; Undo restores them.' }] : [])
    ]
  }
  return [{ label: '', text: body }]
}

type MountedCard = { block: ObjectBlock; dispose?: () => void }
const mountedCards = new WeakMap<HTMLElement, MountedCard>()

export class CardWidget extends ObjectWidget {
  readonly expanded: boolean
  readonly statuses: ReadonlyMap<string, CardFileStatus>
  /** The statuses of this card's own references, as one comparable string. */
  readonly statusKey: string
  readonly preview: CardPreviewKind | null

  constructor(block: ObjectBlock, selected: boolean, raw: boolean, expanded: boolean, statuses: ReadonlyMap<string, CardFileStatus> = new Map(), previews = false) {
    super(block, selected, raw)
    this.expanded = expanded
    this.statuses = statuses
    this.preview = previews ? cardPreviewKind(block) : null
    this.statusKey = cardStatusRefs(block).map((ref) => `${ref}=${statuses.get(ref)?.state ?? ''}`).join('|')
  }

  eq(other: WidgetType): boolean {
    return super.eq(other) && other instanceof CardWidget && this.sameDisplay(other)
  }

  private sameDisplay(other: CardWidget): boolean {
    return this.expanded === other.expanded && this.statusKey === other.statusKey
      && this.preview === other.preview && this.block.design === other.block.design
  }

  updateDOM(dom: HTMLElement, _view: EditorView, from: this): boolean {
    // Typing above a visible card moves its source offsets. Keep its rendered body and point the
    // existing controls at the new range, instead of reading the HTML file again on each keystroke.
    if (!this.preview || !this.sameDisplay(from) || this.raw !== from.raw
        || this.block.kind !== from.block.kind || this.block.source !== from.block.source
        || this.block.simulationVersion !== from.block.simulationVersion) return false
    const mounted = mountedCards.get(dom)
    if (!mounted) return false
    mounted.block = this.block
    dom.classList.toggle('tw-obj-selected', this.selected)
    return true
  }

  destroy(dom: HTMLElement): void {
    mountedCards.get(dom)?.dispose?.()
    mountedCards.delete(dom)
    super.destroy(dom)
  }

  /** The status of the file this card's first line names (a local page, simulation or clip). */
  private ownFileStatus(): CardFileStatus | undefined {
    const facts = this.block.embed
    return facts && (facts.variant === 'local' || facts.variant === 'simulation' || facts.variant === 'video')
      ? this.statuses.get(facts.src)
      : undefined
  }

  get estimatedHeight(): number {
    if (this.expanded || this.raw) return 220
    if (this.block.kind === 'notes') return 32
    if (this.preview === 'page') return 195
    return this.preview ? 136 : 58
  }

  toDOM(view: EditorView): HTMLElement {
    const summary = cardSummary(this.block)
    const shell = el('div', `tw-obj tw-obj-card tw-obj-card-${this.block.kind}${this.selected ? ' tw-obj-selected' : ''}`)
    shell.dataset.objectBlock = this.block.kind
    const mounted: MountedCard = { block: this.block }
    mountedCards.set(shell, mounted)
    const header = el('div', 'tw-obj-head')
    if (this.block.kind === 'notes') {
      this.notesHeader(view, header, summary, mounted)
      shell.append(header)
      if (this.raw) this.rawSource(shell)
      return shell
    }
    header.append(el('span', 'tw-obj-kind', summary.title))
    header.append(el('span', 'tw-obj-step', summary.detail))
    for (const chip of summary.chips) {
      const node = el('span', 'tw-obj-chip', chip)
      if (this.block.kind === 'comment' && this.block.comment) node.title = this.block.comment.explanation
      header.append(node)
    }
    const own = this.ownFileStatus()
    const note = cardFileNote(own)
    const readPage = view.state.facet(cardMediaFacet).readPage
    if (note) header.append(el('span', `tw-obj-chip tw-obj-status tw-obj-status-${own?.state}`, note))
    header.append(this.actions(view, mounted))
    header.append(this.toggle(view, 'tw-obj-raw', '</>', this.raw, this.raw ? 'Hide the source' : 'Show the source', () =>
      setRawObjectBlock.of({ from: mounted.block.from, raw: !this.raw })))
    header.append(this.toggle(view, 'tw-obj-expand', this.expanded ? '⌃' : '⌄', this.expanded, this.expanded ? 'Collapse' : 'Expand', () =>
      setExpandedObjectBlock.of({ from: mounted.block.from, expanded: !this.expanded })))
    shell.append(header)
    if (this.raw) {
      this.rawSource(shell)
    } else if (this.preview && this.preview !== 'page') {
      const visual = simulationPreview(this.block, this.preview)
      if (this.expanded) visual.classList.add('is-expanded')
      shell.append(visual)
    } else if (this.preview === 'page' && this.block.embed && !note && readPage) {
      const { src, name } = this.block.embed
      const host = el('div', 'tw-obj-preview-frame', 'Loading page preview…')
      if (this.expanded) host.classList.add('is-expanded')
      shell.append(host)
      mounted.dispose = showPagePreview(host, name, () => readPage(src))
    } else if (this.expanded) {
      const body = el('div', 'tw-obj-body tw-obj-card-expanded')
      for (const row of expandedRows(this.block)) {
        const line = el('div', 'tw-obj-card-row')
        if (row.label) line.append(el('span', 'tw-obj-card-role', row.label))
        line.append(el('pre', 'tw-obj-card-text', row.text))
        body.append(line)
      }
      if (this.block.embed?.captures.length) body.append(this.savedViews(view))
      shell.append(body)
    } else if (summary.first) {
      shell.append(el('div', `tw-obj-card-first${summary.mono ? ' is-mono' : ''}`, summary.first))
    } else if (!objectBlockEditableSource(this.block).trim()) {
      shell.append(el('div', 'tw-obj-card-first', cardKind(this.block.kind)?.emptyPrompt ?? ''))
    }
    shell.append(el('span', 'tw-obj-hint', '↵ edit · ⌫ delete'))
    return shell
  }

  private notesHeader(view: EditorView, header: HTMLElement, summary: ReturnType<typeof cardSummary>, mounted: MountedCard): void {
    const open = el('button', 'workspace-notes-toggle tw-obj-expand tw-notes-disclosure')
    open.type = 'button'
    open.setAttribute('aria-expanded', 'false')
    open.setAttribute('aria-label', this.block.deckNotes ? 'Speaker notes for the whole talk' : 'Speaker notes')
    open.title = [NOTES_PRIVACY_TEXT, summary.detail].filter(Boolean).join(' · ')
    open.append(el('span', 'tw-notes-chevron'), el('strong', '', summary.title))
    if (!this.raw) open.append(el('span', 'tw-notes-first', summary.first ?? 'None yet'))
    open.addEventListener('mousedown', event => event.stopPropagation())
    open.addEventListener('click', () => {
      const { from, to, source } = this.block
      if (view.state.doc.sliceString(from, to) !== source) return
      view.dispatch({ selection: { anchor: from }, effects: setOpenObjectBlock.of({ from, to }), scrollIntoView: true })
    })
    if (!this.block.deckNotes) header.append(notesMoveHandle(view, this.block))
    header.append(open, this.actions(view, mounted))
    header.append(this.toggle(view, 'tw-obj-raw', '</>', this.raw, this.raw ? 'Hide the source' : 'Show the source', () =>
      setRawObjectBlock.of({ from: this.block.from, raw: !this.raw })))
  }

  /** The page's saved views: a local thumbnail when the editor can resolve one, and a per-view Remove. */
  private savedViews(view: EditorView): HTMLElement {
    const strip = el('div', 'tw-obj-card-views')
    const resolve = view.state.facet(cardMediaFacet).resolveImage
    for (const capture of this.block.embed?.captures ?? []) {
      const item = el('div', 'tw-obj-card-view')
      // Only the capture writer's own local pictures are shown; nothing remote is ever requested.
      const fileNote = cardFileNote(this.statuses.get(capture.src))
      const url = capture.savedView && !fileNote ? resolve?.(capture.src) ?? null : null
      if (url && !/^https?:/i.test(url)) {
        const img = el('img', 'tw-obj-card-thumb')
        img.alt = capture.alt
        img.src = url
        item.append(img)
      }
      item.append(el('span', 'tw-obj-card-view-label', capture.savedView ? capture.alt || 'Saved view' : `${capture.alt || 'View'} (not a saved-view picture)`))
      if (fileNote) item.append(el('span', 'tw-obj-card-view-label tw-obj-status', fileNote))
      const remove = el('button', 'tw-obj-card-view-remove', 'Remove from slide')
      remove.type = 'button'
      remove.title = 'Takes this view off the slide; the picture stays in the talk folder. Undo restores it.'
      remove.addEventListener('mousedown', (event) => {
        event.preventDefault()
        event.stopPropagation()
        removeCardLine(view, this.block, capture.line)
      })
      item.append(remove)
      strip.append(item)
    }
    return strip
  }

  /** Open, Reveal, Copy markup, Replace file and Remove (cardActions.ts); shown on hover and when selected. */
  private actions(view: EditorView, mounted: MountedCard): HTMLElement {
    const strip = el('span', 'tw-obj-actions')
    for (const action of cardActionsFor(this.block, view.state.facet(cardActionHost))) {
      const label = CARD_ACTION_LABELS[action]
      const button = el('button', `tw-obj-action tw-obj-action-${action}`, label.glyph)
      button.type = 'button'
      button.title = label.title
      button.setAttribute('aria-label', label.title)
      button.dataset.cardAction = action
      button.addEventListener('mousedown', (event) => {
        event.preventDefault()
        event.stopPropagation()
        void runCardAction(view, mounted.block, action)
      })
      strip.append(button)
    }
    return strip
  }

  private toggle(
    view: EditorView,
    className: string,
    text: string,
    active: boolean,
    title: string,
    effect: () => ReturnType<typeof setRawObjectBlock.of> | ReturnType<typeof setExpandedObjectBlock.of>
  ): HTMLButtonElement {
    const button = el('button', `${className}${active ? ' is-active' : ''}`, text)
    button.type = 'button'
    button.title = title
    button.setAttribute('aria-label', title)
    button.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      view.dispatch({ effects: effect() })
      view.focus()
    })
    return button
  }
}

/** Where the editor can find a local picture for a saved view (Editor.tsx wires the image widget's resolver). */
type CardMedia = {
  resolveImage?: (src: string) => string | null
  readPage?: (src: string) => Promise<string | null>
}
export const cardMediaFacet = Facet.define<CardMedia, CardMedia>({
  combine: (values) => values[0] ?? {}
})

/**
 * Remove one line of a card (a saved view) and its own line ending, fail closed: only when the card is
 * still exactly where it was and the line is still in it, as one transaction (one Undo).
 */
export function removeCardLine(view: EditorView, block: ObjectBlock, lineText: string): boolean {
  const doc = view.state.doc
  if (doc.sliceString(block.from, block.to) !== block.source) return false
  const start = doc.lineAt(block.from).number
  const end = doc.lineAt(Math.max(block.from, block.to - 1)).number
  for (let n = start + 1; n <= end; n += 1) {
    const line = doc.line(n)
    if (line.text.replace(/\r$/, '').trim() !== lineText) continue
    const to = n < doc.lines ? doc.line(n + 1).from : line.to
    const from = n < doc.lines ? line.from : Math.max(0, line.from - 1)
    view.dispatch({ changes: { from, to }, userEvent: 'delete', annotations: exactTextWrite.of(true) })
    return true
  }
  return false
}

/** A closed comment inside a line of text: an atomic chip that names it; × removes exactly the comment. */
export class CommentChipWidget extends WidgetType {
  readonly comment: InlineComment

  constructor(comment: InlineComment) {
    super()
    this.comment = comment
  }

  eq(other: WidgetType): boolean {
    return other instanceof CommentChipWidget
      && other.comment.from === this.comment.from
      && other.comment.source === this.comment.source
  }

  toDOM(view: EditorView): HTMLElement {
    const chip = el('span', 'tw-comment-chip')
    chip.dataset.commentChip = ''
    chip.title = `${this.comment.comment.label}\n${this.comment.comment.explanation}\n${this.comment.source}`
    chip.append(el('span', 'tw-comment-chip-mark', '⌥'))
    chip.append(el('span', 'tw-comment-chip-label', 'comment'))
    const remove = el('button', 'tw-comment-chip-remove', '×')
    remove.type = 'button'
    remove.title = 'Remove this comment'
    remove.setAttribute('aria-label', 'Remove this comment')
    remove.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const { from, to, source } = this.comment
      // Fail closed: remove only when the text there is still exactly this comment.
      if (view.state.doc.sliceString(from, to) !== source) return
      view.dispatch({ changes: { from, to }, selection: { anchor: from }, userEvent: 'delete' })
      view.focus()
    })
    chip.append(remove)
    chip.addEventListener('mousedown', (event) => {
      if (event.target === remove) return
      event.preventDefault()
      event.stopPropagation()
      view.dispatch({ selection: { anchor: this.comment.from, head: this.comment.to } })
      view.focus()
    })
    return chip
  }

  ignoreEvent(): boolean {
    return true
  }
}

/** The explicit, bounded fix for unclosed notes: "Add closing :::" (design §4.1). */
export class AddNotesCloseWidget extends WidgetType {
  readonly closeAt: number
  readonly opener: number

  constructor(opener: number, closeAt: number) {
    super()
    this.opener = opener
    this.closeAt = closeAt
  }

  eq(other: WidgetType): boolean {
    return other instanceof AddNotesCloseWidget && other.closeAt === this.closeAt && other.opener === this.opener
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = el('span', 'tw-region-warning-note')
    wrap.append(el('span', '', ' No closing ::: — everything down to the next slide heading is notes. '))
    const button = el('button', 'tw-region-warning-action', 'Add closing :::')
    button.type = 'button'
    button.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      // Re-read the current text and close only what the compiler will read as closed, private notes.
      const doc = view.state.doc
      const plan = this.opener <= doc.length ? planNotesClose(doc.toString(), doc.lineAt(this.opener).number - 1) : null
      if (!plan || !plan.ok) {
        notify(plan?.message ?? 'These notes were changed. Try again.', 'warning', 'notes-close')
        return
      }
      view.dispatch({ changes: { from: plan.from, insert: plan.insert }, userEvent: 'input' })
      view.focus()
    })
    wrap.append(button)
    return wrap
  }

  ignoreEvent(): boolean {
    return true
  }
}

export function cardWidgetFor(block: ObjectBlock, selected: boolean, raw: boolean, expanded: boolean, statuses?: ReadonlyMap<string, CardFileStatus>, previews?: boolean): CardWidget {
  return new CardWidget(block, selected, raw, expanded, statuses, previews)
}
