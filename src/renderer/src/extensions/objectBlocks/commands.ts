// Editor commands for the object cards that are not the open/close chain (ADR-0042 and its notes and
// comments addendum): insert speaker notes, delete the comment at the caret, discard an open card editor,
// and the notice after a card deletion. Each writes in one transaction, so one Undo restores it.
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { readOutlineObjectRegions } from '../../../../shared/objects/outline-object-regions.ts'
import { planNotesInsert, slideAround } from '../../../../shared/objects/notes-planner.ts'
import { notify } from '../../lib/notify.ts'
import { objectBlocksIn } from './field.ts'
import { setOpenObjectBlock } from './effects.ts'
import type { ObjectBlock } from './detect.ts'
import { cardStatusRefs, objectStatusField, objectStatusSource, setObjectStatuses, type CardFileStatus } from './status.ts'

/**
 * Insert speaker notes for the slide at the caret (design §4.5) through the shared notes planner, which
 * the compiler's reading must confirm keeps the new block private. A slide with notes opens them (the
 * first at or after the caret, else the last); unclosed notes or a refused proposal write nothing and say
 * why. Before the first heading there is no slide: nothing happens.
 */
export function insertSpeakerNotes(view: EditorView): boolean {
  const state = view.state
  const text = state.doc.toString()
  const caretLine = state.doc.lineAt(state.selection.main.head).number - 1
  const plan = planNotesInsert(text, caretLine)
  if (!plan.ok) {
    if (plan.code === 'exists') {
      const regions = readOutlineObjectRegions(text)
      const slide = slideAround(text, caretLine, regions)
      const head = state.selection.main.head
      const blocks = objectBlocksIn(state).filter((b) => b.kind === 'notes' && slide
        && b.from >= regions.lineStarts[slide.heading] && b.from < (regions.lineStarts[slide.end] ?? text.length + 1))
      const target = blocks.find((b) => b.from >= head) ?? blocks[blocks.length - 1]
      if (target) {
        view.dispatch({ selection: { anchor: target.from }, effects: setOpenObjectBlock.of({ from: target.from, to: target.to }), scrollIntoView: true })
        return true
      }
      if (plan.open !== undefined) view.dispatch({ selection: { anchor: regions.lineStarts[plan.open] }, scrollIntoView: true })
    }
    notify(plan.message, plan.code === 'not-found' ? 'info' : 'warning', 'insert-notes')
    return true
  }
  const eolLength = plan.insert.startsWith('\r\n') ? 2 : 1
  const from = plan.from + eolLength * 2
  view.dispatch({ changes: { from: plan.from, insert: plan.insert }, selection: { anchor: from }, userEvent: 'input.notes', scrollIntoView: true })
  const block = objectBlocksIn(view.state).find((b) => b.kind === 'notes' && b.from === from)
  if (block) view.dispatch({ effects: setOpenObjectBlock.of({ from: block.from, to: block.to }) })
  return true
}

/**
 * Delete the closed HTML comment at the caret, wherever it sits on its lines (design §5.3): the one way
 * to remove a mixed multi-line comment that stays raw. A comment alone on its lines goes with its lines.
 * Comments inside a fence are code and are left alone.
 */
export function deleteCommentAtCaret(view: EditorView): boolean {
  const state = view.state
  const text = state.doc.toString()
  const head = state.selection.main.head
  const regions = readOutlineObjectRegions(text)
  const found = regions.comments.find((c) => c.container !== 'fence' && c.container !== 'frontmatter' && head >= c.from && head <= c.to)
  if (!found) return false
  let from = found.from
  let to = found.to
  if (found.standalone) {
    from = regions.lineStarts[found.startLine]
    const nextLine = found.endLine + 1
    to = nextLine < regions.lineStarts.length - 1 ? regions.lineStarts[nextLine] : text.length
    if (to === text.length && from > 0) from -= 1
  }
  view.dispatch({ changes: { from, to }, selection: { anchor: from }, userEvent: 'delete.comment', scrollIntoView: true })
  notify('Comment deleted. Undo restores it.', 'info', 'delete-comment')
  return true
}

/** Discard the open card editor: close it and write nothing (no change, so no undo step). */
export function discardOpenObject(view: EditorView): boolean {
  const shell = view.dom.querySelector<HTMLElement & { __twDiscard?: () => void }>('.oe')
  if (!shell?.__twDiscard) return false
  shell.__twDiscard()
  return true
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

/** What deleting a card removed, in one sentence, or null when it needs no notice. */
export function deletionNotice(block: ObjectBlock): string | null {
  if (block.kind === 'notes') {
    const body = block.source.split('\n').slice(1, -1).join('\n')
    return `Removed speaker notes (${wordCount(body)} words). Undo restores them.`
  }
  if (block.kind === 'embed' && block.embed && (block.embed.captures.length || block.embed.marker)) {
    const n = block.embed.captures.length
    return `Removed the page and its ${n} saved view${n === 1 ? '' : 's'} from this slide. The pictures stay in the talk’s folder. Undo restores them.`
  }
  if (block.kind === 'comment' && block.comment?.kind === 'capture-marker') {
    return 'Removed the saved-views marker. Undo restores it.'
  }
  return null
}

/** A notice when a delete or cut removes a whole notes block, a page with saved views or a marker. */
export const objectDeletionNotices: Extension = EditorView.updateListener.of((update) => {
  if (!update.docChanged) return
  if (!update.transactions.some((tr) => tr.isUserEvent('delete') || tr.isUserEvent('cut') || tr.isUserEvent('input'))) return
  const before = objectBlocksIn(update.startState)
  if (!before.length) return
  const removed: ObjectBlock[] = []
  update.changes.iterChangedRanges((fromA, toA) => {
    for (const block of before) if (block.from >= fromA && block.to <= toA && block.to > block.from) removed.push(block)
  })
  for (const block of removed) {
    const message = deletionNotice(block)
    if (message) notify(message, 'info', `object-deleted-${block.kind}`)
  }
})

const STATUS_DEBOUNCE_MS = 300

/** The references every card in this document names, de-duplicated, in document order. */
export function documentStatusRefs(blocks: readonly ObjectBlock[]): string[] {
  return [...new Set(blocks.flatMap(cardStatusRefs))]
}

/** The statuses in `answer` that differ from what the editor already holds, or null when none does. */
export function changedStatuses(held: ReadonlyMap<string, CardFileStatus>, answer: ReadonlyMap<string, CardFileStatus>): Map<string, CardFileStatus> | null {
  const changed = new Map<string, CardFileStatus>()
  for (const [ref, status] of answer) {
    const was = held.get(ref)
    if (!was || was.state !== status.state || was.path !== status.path) changed.set(ref, status)
  }
  return changed.size ? changed : null
}

/**
 * Asks main for the file status of every card's references (objectStatusSource), once after the editor
 * opens and again a short while after each edit; only changed statuses are dispatched, so a quiet answer
 * costs no redraw. With no source configured (tests, a window without a talk) it asks nothing.
 */
export const objectStatusRequests = ViewPlugin.fromClass(class {
  private timer: ReturnType<typeof setTimeout> | null = null
  private destroyed = false
  private asked = ''
  private readonly view: EditorView

  constructor(view: EditorView) {
    this.view = view
    this.schedule()
  }

  update(update: ViewUpdate): void {
    if (update.docChanged) this.schedule()
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; void this.request() }, STATUS_DEBOUNCE_MS)
  }

  private async request(): Promise<void> {
    const source = this.view.state.facet(objectStatusSource)
    if (!source || this.destroyed) return
    const refs = documentStatusRefs(objectBlocksIn(this.view.state))
    const key = `${source.scope()}\n${refs.join('\n')}`
    if (!refs.length || key === this.asked) return
    this.asked = key
    let answer: Map<string, CardFileStatus> | null = null
    try { answer = await source.ask(refs) } catch { answer = null }
    if (this.destroyed) return
    if (!answer) { this.asked = ''; return }
    const changed = changedStatuses(this.view.state.field(objectStatusField, false) ?? new Map(), answer)
    if (changed) this.view.dispatch({ effects: setObjectStatuses.of(changed) })
  }

  destroy(): void {
    this.destroyed = true
    if (this.timer) clearTimeout(this.timer)
  }
})
