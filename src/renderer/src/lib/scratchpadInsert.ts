import type { SlidePlace } from '../../../shared/slide-handling/place.ts'
// Slide Scratchpad ticket 2: the two Insert actions, run against the workspace's own outline writers. Nothing here
// writes the outline by itself: a new slide goes in through the one-writer seam's apply (lib/outlineMutation, one
// minimal change to the editor's buffer, one undo step, saved through the file's queue), a visual at the cursor
// through the editor's caret insert (the image drawer's path). A picked slide is made ready for this talk by the
// Slide Browser's own step (prepareInsertedSlide: media copied from another vault, a taken id re-stamped, or its
// pictures put into this vault's pool). Every step before the outline change can refuse; a refusal says why and
// leaves the outline as it was. After an insert the item stays in the Slide Scratchpad, marked with when and where.
import type { OutlineMutationResult } from './outlineMutation.ts'
import { HTML_PAGE_INSERT_TEXT } from './insertHtmlPage.ts'
import type { ScratchItem, ScratchReply, ScratchSnapshot, ScratchVisualImport } from '../../../shared/scratchpad.ts'
import {
  placeRows, planScratchSlides, caretInSlideBody, headingTitle, insertSlideAt, placeForLine, restampTakenIds, visualNeedsCopy, visualSlide, scratchVisuals,
  type ScratchPlace, type ScratchVisual
} from '../../../shared/scratchpad-insert.ts'

type NotifyKind = 'info' | 'success' | 'warning' | 'error'

export interface ScratchInsertHost {
  /** The outline path of the talk open in the editor now, or null. */
  talk(): string | null
  /** The editor's live text and caret, or null when the editor holds no talk. */
  editor(): { path: string; text: string; caret: number } | null
  /** The one-writer seam (WorkspaceLayout applyOutlineMutation): `mutate` works the new text out of the buffer. */
  apply(outlinePath: string, mutate: (current: string) => string): Promise<OutlineMutationResult<unknown>>
  /** The editor's caret insert, then a save (WorkspaceLayout insertAtCaretAndSave). False: nothing went in. */
  insertAtCaret(block: string): Promise<boolean>
  /** A picked slide's markdown made ready for this talk (WorkspaceLayout prepareInsertedSlide); null: refused, and
   *  the person was already told. */
  prepareSlide(markdown: string, sourceOutlinePath: string): Promise<string | null>
  api: {
    importVisual(id: string): Promise<ScratchVisualImport>
    importSlideVisual(id: string, ref: string): Promise<ScratchVisualImport>
    slideSource(id: string): Promise<ScratchReply<{ outlinePath: string }>>
    markInserted(id: string, slideTitle: string): Promise<ScratchReply<{ snapshot: ScratchSnapshot }>>
  }
  notify(message: string, kind: NotifyKind, key?: string): void
}

export type ScratchInsertRequest =
  | { mode: 'slide'; item: ScratchItem; place: SlidePlace }
  /** `atCaret`: the place was not changed by hand, so a caret inside a slide's text takes the visual there. */
  | { mode: 'visual'; item: ScratchItem; visual: ScratchVisual | null; place: SlidePlace; atCaret: boolean }

/** `newSlide`: the place of the slide an insert added (the next insert at a chosen place goes after it). */
export type ScratchInsertOutcome = { ok: true; slideTitle: string; newSlide: ScratchPlace | null } | { ok: false }

export const INSERT_TEXT = {
  noTalk: 'Open a talk first, then insert from the Slide Scratchpad.',
  notReady: 'The talk is not ready in the editor yet. Nothing was inserted; try again.',
  talkChanged: 'Another talk was opened while the item was being prepared, so nothing was inserted.',
  noVisual: 'This slide has no picture, SVG or page to insert on its own.',
  slideInserted: (title: string): string => `Inserted “${title}” as a new slide.`,
  visualSlide: (title: string): string => `Added the visual as a new slide, “${title}”.`,
  visualAtCaret: (title: string): string => `Inserted the visual into “${title}” at the cursor.`,
  failed: (why: string): string => `Couldn’t insert it — ${why}`,
  notMarked: (why: string): string => `It was inserted, but the Slide Scratchpad could not note that: ${why}`
} as const

const FAIL: { ok: false } = { ok: false }

/** One Insert, start to finish. Never throws; every refusal is said. */
export async function runScratchInsert(host: ScratchInsertHost, request: ScratchInsertRequest): Promise<ScratchInsertOutcome> {
  const talk = host.talk()
  if (!talk) { host.notify(INSERT_TEXT.noTalk, 'info', 'scratchpad-insert'); return FAIL }
  try {
    const outcome = request.mode === 'slide' ? await wholeSlide(host, talk, request) : await visualOnly(host, talk, request)
    if (outcome.ok) {
      try {
        const marked = await host.api.markInserted(request.item.id, outcome.slideTitle)
        if (!marked.ok) host.notify(INSERT_TEXT.notMarked(marked.error), 'warning', 'scratchpad-insert-mark')
      } catch (error) { host.notify(INSERT_TEXT.notMarked(error instanceof Error ? error.message : String(error)), 'warning', 'scratchpad-insert-mark') }
    }
    return outcome
  } catch (error) {
    host.notify(INSERT_TEXT.failed(error instanceof Error ? error.message : String(error)), 'warning', 'scratchpad-insert')
    return FAIL
  }
}

/** The new slide put in at `place` through the seam; the outcome names its title and place. */
async function placeSlide(host: ScratchInsertHost, talk: string, place: SlidePlace, block: string): Promise<{ title: string; place: ScratchPlace } | null> {
  if (host.talk() !== talk) { host.notify(INSERT_TEXT.talkChanged, 'warning', 'scratchpad-insert'); return null }
  let placed: { line: number; title: string } | null = null
  const result = await host.apply(talk, (current) => {
    // An id this talk already has (the same picked slide inserted twice) is re-stamped against the text as it is now.
    const r = insertSlideAt(current, place, restampTakenIds(block, current))
    if (!r.ok) throw new Error(r.error)
    placed = { line: r.line, title: headingTitle(r.text.split('\n')[r.line - 1] ?? '') }
    return r.text
  })
  const done = placed as { line: number; title: string } | null
  // `applied`: the slide is in the editor (undoable) though its save failed; the save path said so already.
  if (done && (result.ok || result.applied)) return { title: done.title, place: { kind: 'after', line: done.line, title: done.title } }
  if (!result.ok) host.notify(result.reason === 'not-open' ? INSERT_TEXT.notReady : INSERT_TEXT.failed(result.error), 'warning', 'scratchpad-insert')
  return null
}

async function wholeSlide(host: ScratchInsertHost, talk: string, request: Extract<ScratchInsertRequest, { mode: 'slide' }>): Promise<ScratchInsertOutcome> {
  const { item } = request
  if (item.kind !== 'slide' || !item.slide) { host.notify('Only a picked slide can be inserted whole.', 'info', 'scratchpad-insert'); return FAIL }
  const source = await host.api.slideSource(item.id)
  if (!source.ok) { host.notify(source.error, 'warning', 'scratchpad-insert'); return FAIL }
  const markdown = await host.prepareSlide(item.slide.markdown, source.outlinePath)
  if (markdown === null) return FAIL
  const placed = await placeSlide(host, talk, request.place, markdown)
  if (!placed) return FAIL
  host.notify(INSERT_TEXT.slideInserted(placed.title), 'success', 'scratchpad-insert')
  return { ok: true, slideTitle: placed.title, newSlide: placed.place }
}

/** The line a visual goes in as: copied into this talk by main (agent files, a slide's SVG file or page) or made
 *  ready by the slide insert's own media step (a slide's pictures, drawings and web pages). */
async function visualLine(host: ScratchInsertHost, item: ScratchItem, visual: ScratchVisual | null): Promise<{ line: string; page?: Extract<ScratchVisualImport, { ok: true }>['page'] } | null> {
  if (item.kind === 'file') {
    const reply = await host.api.importVisual(item.id)
    if (!reply.ok) { host.notify(reply.error, 'warning', 'scratchpad-insert'); return null }
    return { line: reply.line, page: reply.page }
  }
  const chosen = visual ?? scratchVisuals(item.slide?.markdown ?? '')[0] ?? null
  if (!chosen || !item.slide) { host.notify(INSERT_TEXT.noVisual, 'info', 'scratchpad-insert'); return null }
  if (visualNeedsCopy(chosen)) {
    const reply = await host.api.importSlideVisual(item.id, chosen.ref)
    if (!reply.ok) { host.notify(reply.error, 'warning', 'scratchpad-insert'); return null }
    return { line: reply.line, page: reply.page }
  }
  const source = await host.api.slideSource(item.id)
  if (!source.ok) { host.notify(source.error, 'warning', 'scratchpad-insert'); return null }
  const ready = await host.prepareSlide(chosen.markdown, source.outlinePath)
  return ready === null ? null : { line: ready.trim() }
}

/** The visual as its own paragraph at the caret: blank lines around it unless the text already has them. */
export function atCaretBlock(text: string, caret: number, line: string): string {
  const atStart = caret === 0 || text[caret - 1] === '\n'
  const atEnd = caret === text.length || text[caret] === '\n'
  const before = text.slice(0, caret)
  const prevBlank = atStart && (caret === 0 || /(^|\n)[ \t]*\n$/.test(before) || before === '\n')
  const after = text.slice(caret)
  const nextBlank = atEnd && (after === '' || /^\n[ \t]*(\n|$)/.test(after))
  const lead = !atStart ? '\n\n' : prevBlank ? '' : '\n'
  const tail = !atEnd ? '\n\n' : nextBlank ? '' : '\n'
  return `${lead}${line.trim()}${tail}`
}

async function visualOnly(host: ScratchInsertHost, talk: string, request: Extract<ScratchInsertRequest, { mode: 'visual' }>): Promise<ScratchInsertOutcome> {
  const { item } = request
  const got = await visualLine(host, item, request.visual)
  if (!got) return FAIL
  if (host.talk() !== talk) { host.notify(INSERT_TEXT.talkChanged, 'warning', 'scratchpad-insert'); return FAIL }
  let outcome: ScratchInsertOutcome = FAIL
  // At the caret only when the place was not changed and the caret is (still) inside a slide's text.
  const editor = request.atCaret ? host.editor() : null
  if (editor && editor.path === talk && caretInSlideBody(editor.text, editor.caret)) {
    const owner = placeForLine(editor.text, editor.text.slice(0, editor.caret).split('\n').length)
    const title = owner.kind === 'after' ? owner.title : ''
    if (!(await host.insertAtCaret(atCaretBlock(editor.text, editor.caret, got.line)))) return FAIL
    host.notify(INSERT_TEXT.visualAtCaret(title), 'success', 'scratchpad-insert')
    outcome = { ok: true, slideTitle: title, newSlide: null }
  } else {
    const placed = await placeSlide(host, talk, request.place, visualSlide(item.title, got.line))
    if (!placed) return FAIL
    host.notify(INSERT_TEXT.visualSlide(placed.title), 'success', 'scratchpad-insert')
    outcome = { ok: true, slideTitle: placed.title, newSlide: placed.place }
  }
  // A page: what Insert › HTML page… always says after its insert (only this file is used).
  if (got.page) {
    const named = got.page.localReferences.length ? ` ${HTML_PAGE_INSERT_TEXT.namedFiles(got.page.localReferences)}` : ''
    host.notify(`${HTML_PAGE_INSERT_TEXT.inserted(got.page.embedPath, got.page.how)} ${HTML_PAGE_INSERT_TEXT.onlyThisFile}${named}`, got.page.localReferences.length ? 'warning' : 'success', 'scratchpad-insert-page')
  }
  return outcome
}


export type ScratchBatchHost = Pick<ScratchInsertHost, 'talk' | 'editor' | 'apply' | 'prepareSlide' | 'notify'> & {
  api: {
    prepareInsert(ids: string[], expectedOutline: string): Promise<ScratchReply<{ entries: import('../../../shared/scratchpad.ts').ScratchPreparedInsert[] }>>
    markInsertedMany(records: import('../../../shared/scratchpad.ts').ScratchInsertedRecord[], expectedOutline: string): Promise<ScratchReply<{ snapshot: ScratchSnapshot }>>
  }
}

/** Prepare all items before the only outline transaction. A refusal never applies a partial batch. */
export async function runScratchBatch(host: ScratchBatchHost, ids: string[], place: SlidePlace): Promise<
  { ok: true; newSlide: ScratchPlace; lines: number[]; selectionLines: number[]; sourceText: string } | { ok: false }
> {
  const talk = host.talk(); const editor = host.editor()
  if (!talk || !editor || editor.path !== talk || !ids.length || new Set(ids).size !== ids.length) return FAIL
  const unchanged = (): boolean => host.talk() === talk && host.editor()?.path === talk && host.editor()?.text === editor.text
  try {
    const prepared = await host.api.prepareInsert(ids, talk)
    if (!prepared.ok) throw new Error(prepared.error)
    if (prepared.entries.length !== ids.length || prepared.entries.some((item, i) => item.id !== ids[i])) throw new Error('The selection changed. Nothing was inserted.')
    const blocks: string[] = []
    for (const item of prepared.entries) {
      if (!unchanged()) throw new Error('The talk changed while preparing the selection. Nothing was inserted.')
      const block = 'markdown' in item ? await host.prepareSlide(item.markdown, item.sourceOutlinePath) : visualSlide(item.title, item.line)
      if (block === null) return FAIL
      blocks.push(block)
    }
    if (!unchanged()) throw new Error('The talk changed while preparing the selection. Nothing was inserted.')
    const planned = planScratchSlides(editor.text, place, blocks)
    if (!planned.ok) throw new Error(planned.error)
    const result = await host.apply(talk, current => {
      if (!unchanged() || current !== editor.text) throw new Error('The talk changed. Nothing was inserted.')
      return planned.text
    })
    if (!result.ok && !result.applied) return FAIL
    const saved = 'saved' in result ? result.saved : null
    const sourceText = saved && typeof saved === 'object' && 'content' in saved && typeof saved.content === 'string' ? saved.content : planned.text
    const beforeRows = placeRows(planned.text); const afterRows = placeRows(sourceText)
    const sameHeadings = beforeRows.length === afterRows.length && beforeRows.every((row, index) => row.title === afterRows[index].title && row.level === afterRows[index].level)
    const canonicalLines = new Map(sameHeadings ? beforeRows.map((row,index) => [row.line, afterRows[index].line]) : [])
    const lines = planned.lines.map(line => canonicalLines.get(line) ?? line)
    const selectionLines = sameHeadings ? planned.selectionLines.map(line => canonicalLines.get(line)!).filter(line => line !== undefined) : []
    const newSlide = planned.lastPlace.kind === 'after' && canonicalLines.has(planned.lastPlace.line) ? { ...planned.lastPlace, line: canonicalLines.get(planned.lastPlace.line)! } : planned.lastPlace
    if (host.talk() === talk) {
      try {
        const records = prepared.entries.map((item, i) => ({ id: item.id, title: headingTitle(planned.text.split('\n')[planned.lines[i] - 1]) }))
        const marked = await host.api.markInsertedMany(records, talk)
        if (!marked.ok) host.notify(INSERT_TEXT.notMarked(marked.error), 'warning', 'scratchpad-insert-mark')
      } catch (error) { host.notify(INSERT_TEXT.notMarked(String(error)), 'warning', 'scratchpad-insert-mark') }
      host.notify(`Inserted ${selectionLines.length || ids.length} slides from ${ids.length} Scratchpad items.`, 'success', 'scratchpad-insert')
    }
    return { ok: true, newSlide, lines, selectionLines, sourceText }
  } catch (error) {
    host.notify(INSERT_TEXT.failed(error instanceof Error ? error.message : String(error)), 'warning', 'scratchpad-insert')
    return FAIL
  }
}
