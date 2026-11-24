import { isolateHistory } from '@codemirror/commands'
import {
  ChangeSet,
  EditorSelection,
  EditorState,
  Facet,
  Transaction,
  Prec,
  StateField,
  StateEffect,
  type StateEffectType,
  type Text,
  type TransactionSpec,
  type Extension,
  type Range,
  type SelectionRange
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  WidgetType,
  keymap,
  type DecorationSet
} from '@codemirror/view'
import { currentFocusRange, inSlideTextPanel, slideTextInput } from '../focusScope.ts'
import { parseTriggerLine } from '../../../../shared/trigger-line.ts'
import { notify } from '../../lib/notify.ts'
import { compilerNotesLines } from '../../../../shared/objects/notes-planner.ts'
import { readOutlineObjectRegions } from '../../../../shared/objects/outline-object-regions.ts'
import {
  detectObjectBlocks,
  detectOutlineObjects,
  type ObjectBlock,
  type OutlineObjects
} from './detect.ts'
import { editNotesAsSource, exactTextWrite, setExpandedObjectBlock, setOpenObjectBlock, setRawObjectBlock } from './effects.ts'
import { widgetForObjectBlock } from './widgets.ts'
import { SlideTextObjectWidget } from './slideTextObject.ts'
import { deleteObjectBlock } from './remove.ts'
import { AddNotesCloseWidget, CommentChipWidget, cardWidgetFor } from './cardWidgets.ts'
import { objectStatusField, type CardFileStatus } from './status.ts'
import { cardKind } from '../../../../shared/objects/card-kinds.ts'
import {
  mountObjectEditor,
  planObjectEditorCommit,
  type ObjectCommitFacts
} from '../../objects/registry.ts'
import type {
  ObjectEditorApi,
  ObjectEditorCommitOptions,
  ObjectEditorCommitResult,
  ObjectEditorCommitContext,
  ShellCheatSheet
} from '../../objects/shell.ts'

export { exactTextWrite, setExpandedObjectBlock, setOpenObjectBlock, setRawObjectBlock } from './effects.ts'

export type ConsumeInsertFence = (replace?: (range: { from: number; to: number } | undefined) => void) => void

export type ObjectBlocksOptions = {
  onInsertMenu?: (coords: { x: number; y: number }, consumeFence: ConsumeInsertFence) => void
  onZoom?: (block: ObjectBlock) => void
  cheatSheet?: ShellCheatSheet
}

// Parsing depends on the immutable document, not the cursor or object UI state. Share one
// index across all fields so a single edit cannot trigger several complete outline scans.
const objectIndex = StateField.define<OutlineObjects>({
  create: (state) => detectOutlineObjects(state.doc.toString(), state.facet(slideTextInput)),
  update: (objects, transaction) => {
    const pictures = transaction.state.facet(slideTextInput)
    return transaction.docChanged || pictures !== transaction.startState.facet(slideTextInput)
      ? detectOutlineObjects(transaction.newDoc.toString(), pictures)
      : objects
  }
})

/** The block objects of the shared index (the field name every reader below used before cards). */
const objectBlockIndex = {
  read: (state: EditorState): ObjectBlock[] => state.field(objectIndex).blocks
}

function cardsIn(state: EditorState): ObjectBlock[] {
  const blocks = state.field(objectIndex, false)?.blocks ?? []
  return state.facet(editNotesAsSource) ? blocks.filter(block => block.kind !== 'notes') : blocks
}

const openBlockField = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(value, transaction) {
    const effect = transaction.effects.find((candidate) => candidate.is(setOpenObjectBlock))
    if (effect) return effect.value
    if (!value) return value
    if (transaction.reconfigured && transaction.state.facet(editNotesAsSource)
      && objectBlockIndex.read(transaction.startState).some(block => block.kind === 'notes' && block.from === value.from)) return null
    if (!transaction.docChanged) return value
    // WriteFlex walk finding: edge association grows an open object when a new row/node is typed
    // at either edge instead of silently dropping out of edit mode.
    const from = transaction.changes.mapPos(value.from, -1)
    const blocks = objectBlockIndex.read(transaction.state)
    const head = transaction.newSelection.main.head
    const atCaret = blocks.find((block) =>
      head >= block.from
      && (head < block.to || (block.to >= transaction.newDoc.length && head <= block.to))
    )
    const anchored = atCaret ?? blocks.find((block) => block.from === from)
    return anchored ? { from: anchored.from, to: anchored.to } : null
  }
})

function mappedBlockSet(
  effectType: StateEffectType<{ from: number; expanded: boolean }>,
  flag: 'expanded'
) {
  return StateField.define<Set<number>>({
    create: () => new Set(),
    update(value, transaction) {
      let next: Set<number>
      if (transaction.docChanged) {
        const oldBlocks = objectBlockIndex.read(transaction.startState)
        const newBlocks = objectBlockIndex.read(transaction.state)
        next = new Set()
        for (const oldFrom of value) {
          const oldBlock = oldBlocks.find((block) => block.from === oldFrom)
          if (!oldBlock) continue
          const mappedFrom = transaction.changes.mapPos(oldBlock.from, -1)
          const mappedTo = transaction.changes.mapPos(oldBlock.to, 1)
          if (mappedFrom >= mappedTo) continue
          const mappedBlock = newBlocks.find((block) => block.from >= mappedFrom && block.from < mappedTo)
          if (mappedBlock) next.add(mappedBlock.from)
        }
      } else {
        next = new Set(value)
      }
      for (const effect of transaction.effects) {
        if (!effect.is(effectType)) continue
        const value = effect.value
        if (value[flag]) next.add(value.from)
        else next.delete(value.from)
      }
      return next
    }
  })
}

/** Expanded cards: per-session chrome (ADR-0042), mapped through edits like the raw view. */
const expandedBlockField = mappedBlockSet(setExpandedObjectBlock, 'expanded')

const rawBlockField = StateField.define<Set<number>>({
  create: () => new Set(),
  update(value, transaction) {
    let next: Set<number>
    if (transaction.docChanged) {
      const oldBlocks = objectBlockIndex.read(transaction.startState)
      const newBlocks = objectBlockIndex.read(transaction.state)
      next = new Set()
      for (const oldFrom of value) {
        const oldBlock = oldBlocks.find((block) => block.from === oldFrom)
        if (!oldBlock) continue
        const mappedFrom = transaction.changes.mapPos(oldBlock.from, -1)
        const mappedTo = transaction.changes.mapPos(oldBlock.to, 1)
        // A fully deleted range collapses. Do not let its mapped start transplant raw mode onto
        // an unrelated object that shifted into the same offset.
        if (mappedFrom >= mappedTo) continue
        const mappedBlock = newBlocks.find((block) =>
          block.from >= mappedFrom && block.from < mappedTo
        )
        if (mappedBlock) next.add(mappedBlock.from)
      }
    } else {
      next = new Set(value)
    }
    for (const effect of transaction.effects) {
      if (!effect.is(setRawObjectBlock)) continue
      if (effect.value.raw) next.add(effect.value.from)
      else next.delete(effect.value.from)
    }
    return next
  }
})

const setInsertFence = StateEffect.define<{ from: number; to: number } | null>()
const insertFenceField = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(value, tr) {
    const effect = tr.effects.find((candidate) => candidate.is(setInsertFence))
    if (effect) return effect.value
    if (!value || !tr.docChanged) return value
    const from = tr.changes.mapPos(value.from, 1)
    const to = tr.changes.mapPos(value.to, -1)
    return to - from === 3 && tr.newDoc.sliceString(from, to) === '```' ? { from, to } : null
  }
})

export const sourceObjectPreviews = Facet.define<boolean, boolean>({
  combine: (values) => values[0] ?? false
})

const objectBlocksOptions = Facet.define<ObjectBlocksOptions, ObjectBlocksOptions>({
  combine: (values) => values[0] ?? {}
})

type ObjectBlockState = {
  blocks: ObjectBlock[]
  decorations: DecorationSet
  atomic: DecorationSet
}

/** Kinds whose editors commit as their own undo step and offer Discard (ADR-0042; tables keep theirs). */
export function isCardBlock(block: ObjectBlock): boolean {
  return cardKind(block.kind) !== undefined
}

function blockIsSelected(state: EditorState, block: ObjectBlock, gap: ObjectBlock | null): boolean {
  const docLength = state.doc.length
  if (gap?.from === block.from) return false
  return state.selection.ranges.some(({ head }) =>
    head >= block.from && (head < block.to || (block.to >= docLength && head <= block.to))
  )
}

// ── The line after an object ────────────────────────────────────────────────────────────────────
// An object followed directly by a title, by another object or by the end of the document (or of the
// Slide Focus band) has no line of its own after it to put the caret on. The editor offers one: the
// object's last line end (`objectEnd`) is a caret stop drawn as an empty line under the object (the
// gap). Nothing is written until the person types, pastes or presses Enter there; then the line is made,
// with a blank line between it and the object. Opening or saving a talk never adds it.

/** Where an object's last line ends (an embed's source runs on to its newline; a fence's does not). */
export function objectEnd(state: EditorState, block: Pick<ObjectBlock, 'from' | 'to'>): number {
  return state.doc.lineAt(Math.max(block.from, Math.min(block.to, state.doc.length) - 1)).to
}

/** This closed object has no line after it before a title, another object or the end. */
function hasGapAfter(state: EditorState, block: ObjectBlock, blocks: readonly ObjectBlock[]): boolean {
  return gapAfterWith(state, block, (pos) => blocks.some((other) => other.from === pos))
}

function gapAfterWith(state: EditorState, block: ObjectBlock, objectStartsAt: (pos: number) => boolean): boolean {
  if (state.field(openBlockField, false)?.from === block.from) return false
  if (!blockIsInsideFocus(block, state)) return false
  const end = objectEnd(state, block)
  if (end >= state.doc.length) return true
  const focus = currentFocusRange(state)
  if (focus && end + 1 > focus.to) return true
  const next = state.doc.lineAt(end + 1)
  return /^#{1,6}(?:\s|$)/.test(next.text) || objectStartsAt(next.from)
}

/** This object (by its start) has a gap after it. */
function blockHasGap(state: EditorState, from: number): boolean {
  const blocks = cardsIn(state)
  const block = blocks.find((candidate) => candidate.from === from)
  return Boolean(block && hasGapAfter(state, block, blocks))
}

/** The object whose gap holds the (single, empty) caret, or null. */
export function caretGapBlock(state: EditorState): ObjectBlock | null {
  const sel = state.selection
  if (sel.ranges.length !== 1 || !sel.main.empty) return null
  const head = sel.main.head
  // (An editor without the object field, as some tests build, has no objects and so no gap.)
  const blocks = state.field(objectIndex, false)?.blocks ?? []
  for (const block of blocks) {
    if (block.from > head) break
    if (objectEnd(state, block) === head && hasGapAfter(state, block, blocks)) return block
  }
  return null
}

/** Where a block put in "at the caret" anchors: with a closed object selected, the end of the object's
 *  last line (so the block goes after the object, never into it); otherwise the caret. */
export function insertionCaret(state: EditorState): number {
  const head = state.selection.main.head
  const block = state.field(objectIndex, false) ? activeBlock(state) : undefined
  return block && !blockIsOpen(state, block) ? objectEnd(state, block) : head
}

/** A place a block goes in after (a drop point): on a closed object's lines it is the end of the object's
 *  last line, so the block goes after the object, never into it. */
export function insertionPlace(state: EditorState, pos: number): number {
  const blocks = cardsIn(state)
  const open = state.field(openBlockField, false)
  for (const block of blocks) {
    if (block.from > pos) break
    const end = objectEnd(state, block)
    if (pos <= end && open?.from !== block.from) return end
  }
  return pos
}

/** The empty line drawn under an object that has no line after it; it shows the caret when it holds it. */
export class ObjectGapWidget extends WidgetType {
  readonly caret: boolean

  constructor(caret: boolean) {
    super()
    this.caret = caret
  }

  eq(other: WidgetType): boolean {
    return other instanceof ObjectGapWidget && other.caret === this.caret
  }

  toDOM(): HTMLElement {
    const gap = document.createElement('div')
    gap.className = `tw-obj-gap${this.caret ? ' is-caret' : ''}`
    gap.setAttribute('aria-hidden', 'true')
    gap.title = 'Click to write after the object'
    return gap
  }

  get estimatedHeight(): number {
    return 24
  }

  ignoreEvent(event: Event): boolean {
    return event.type !== 'mousedown'
  }
}

function blockIsInsideFocus(block: ObjectBlock, state: EditorState): boolean {
  const focus = currentFocusRange(state)
  if (!focus) return true
  // The focus field describes the visible band. Any object that crosses into either hidden band
  // is omitted so its block replacement never overlaps Slide Focus's own hiding replacements.
  // The replacement stops before the final line break, which the object source may include.
  const visibleEnd = state.doc.lineAt(Math.max(block.from, block.to - 1)).to
  return block.from >= focus.from && visibleEnd <= focus.to
}

export class ObjectEditorWidget extends WidgetType {
  readonly block: ObjectBlock
  readonly cheatSheet?: ShellCheatSheet
  private view?: EditorView

  constructor(block: ObjectBlock, cheatSheet?: ShellCheatSheet) {
    super()
    this.block = block
    this.cheatSheet = cheatSheet
  }

  eq(other: WidgetType): boolean {
    return other instanceof ObjectEditorWidget
      && other.block.kind === this.block.kind
      && other.block.from === this.block.from
      && other.block.to === this.block.to
      && other.block.source === this.block.source
      && other.block.simulationVersion === this.block.simulationVersion
      && other.cheatSheet === this.cheatSheet
  }

  private editorApi(view: EditorView): ObjectEditorApi {
    const preflight = (inner: string, options?: ObjectEditorCommitOptions): ObjectEditorCommitResult => {
      const focusRefusal = blockIsInsideFocus(this.block, view.state)
        ? null
        : 'the object block is outside the current Slide Focus band'
      if (focusRefusal) {
        console.error(`[error] ObjectEditor commit refused: ${focusRefusal}`)
        return { ok: false, reason: focusRefusal }
      }
      const plan = planObjectEditorCommit(this.block, view.state.doc.toString(), inner, options, commitFacts(view))
      if (!plan.ok) {
        console.error(`[error] ObjectEditor commit refused: ${plan.reason}`)
        return plan
      }
      return { ok: true }
    }
    const commit = (
      inner: string,
      _context: ObjectEditorCommitContext,
      options?: ObjectEditorCommitOptions
    ): ObjectEditorCommitResult => {
      const focusRefusal = blockIsInsideFocus(this.block, view.state)
        ? null
        : 'the object block is outside the current Slide Focus band'
      if (focusRefusal) return { ok: false, reason: focusRefusal }
      const plan = planObjectEditorCommit(this.block, view.state.doc.toString(), inner, options, commitFacts(view))
      if (!plan.ok) return plan
      const card = isCardBlock(this.block)
      if (card && plan.change.insert === view.state.doc.sliceString(plan.change.from, plan.change.to)) {
        // A no-op commit writes nothing: no transaction, no undo step, no autosave (ADR-0042).
        view.dispatch({ selection: { anchor: this.block.from }, effects: setOpenObjectBlock.of(null) })
        view.focus()
        return { ok: true }
      }
      // Replace ONLY the planner-approved range (the body for fenced objects, the complete block
      // otherwise). The editor update listener then follows the ordinary onContentChange →
      // guarded autosave path; there is no second object-specific writer.
      view.dispatch({
        changes: plan.change,
        selection: { anchor: this.block.from },
        effects: setOpenObjectBlock.of(null),
        userEvent: 'input',
        // A card's commit is one undo step of its own: never merged with typing before or after it.
        ...(card ? { annotations: isolateHistory.of('full') } : {}),
        scrollIntoView: true
      })
      if (view.state.doc.sliceString(
        plan.change.from,
        plan.change.from + plan.change.insert.length
      ) !== plan.change.insert) {
        console.error('[error] ObjectEditor commit was rejected by a document guard.')
      }
      const committed = detectObjectBlocks(view.state.doc.toString())
        .find((item) => item.from === this.block.from)
      if (committed?.kind !== this.block.kind && !options?.wholeBlock) {
        console.error(
          `[warning] ObjectEditor commit no longer detects as ${this.block.kind}.\n`
          + `Before:\n${this.block.source}\nAfter:\n${committed?.source ?? '(missing)'}`
        )
      }
      view.focus()
      return { ok: true }
    }
    // Discard (cards only): close the editor and write nothing. The only transaction carries the close
    // effect; there is no change, so no undo step and no autosave.
    const discard = (): void => {
      view.dispatch({ effects: setOpenObjectBlock.of(null) })
      view.focus()
    }
    return { preflight, commit, ...(isCardBlock(this.block) ? { discard } : {}) }
  }

  toDOM(view: EditorView): HTMLElement {
    this.view = view
    return mountObjectEditor(this.block, this.editorApi(view), this.cheatSheet)
  }

  updateDOM(dom: HTMLElement, view: EditorView, from: this): boolean {
    this.view = view
    const shell = dom as HTMLElement & {
      __twPreflightTeardown?: () => ObjectEditorCommitResult
      __twRetargetApi?: (next: ObjectEditorApi) => void
    }
    const result = shell.__twPreflightTeardown?.()
    if (!result || result.ok) return false
    // The same source moving because bytes were inserted above it is still the same open edit.
    // Retarget future commit attempts to the mapped block, but keep the refusal note visible.
    if (from.block.kind === this.block.kind && from.block.source === this.block.source) {
      shell.__twRetargetApi?.(this.editorApi(view))
    }
    return true
  }

  // The EDITING widget owns its events entirely — with false, CM processes cell/node clicks and
  // yanks focus back to the document (C4.1).
  ignoreEvent(): boolean {
    return true
  }

  destroy(dom: HTMLElement): void {
    // A surviving block is handled by updateDOM, which can veto teardown and keep this exact shell.
    // If the block disappeared (or the whole editor was destroyed), no host remains for the typed
    // content. That case is unrecoverable by definition, so surface it as a visible persistent toast.
    const commit = (dom as HTMLElement & {
      __twCommit?: (context?: ObjectEditorCommitContext) => ObjectEditorCommitResult
    }).__twCommit
    if (!commit) return
    queueMicrotask(() => {
      const result = commit('teardown')
      if (result.ok) return
      const blockStillExists = detectObjectBlocks(this.view?.state.doc.toString() ?? '')
        .some((candidate) =>
          candidate.kind === this.block.kind && candidate.source === this.block.source
        )
      const reason = blockStillExists
        ? result.reason
        : 'the object block no longer exists'
      notify(
        `Your unsaved object edit could not be kept because ${reason}.`,
        'error',
        'object-edit-unrecoverable'
      )
    })
  }
}

/**
 * Build block replacements from state. WriteFlex C1 and TalkWeaver frontmatterTable.ts:247-249
 * require block Decoration.replace ranges to come from a StateField, never a ViewPlugin.
 */
function buildObjectBlockState(state: EditorState): ObjectBlockState {
  const blocks = cardsIn(state)
  const open = state.field(openBlockField)
  const raw = state.field(rawBlockField)
  const expanded = state.field(expandedBlockField)
  const statuses = state.field(objectStatusField, false) ?? new Map<string, CardFileStatus>()
  const options = state.facet(objectBlocksOptions)
  const objects = state.field(objectIndex)
  const ranges: Array<Range<Decoration>> = []
  const atomicRanges: Array<Range<Decoration>> = []
  const gapHolder = caretGapBlock(state)
  const slideTextRange = inSlideTextPanel(state) ? currentFocusRange(state) : null
  const starts = new Set(blocks.map((block) => block.from))
  const previews = state.facet(sourceObjectPreviews)

  for (const block of blocks) {
    if (!blockIsInsideFocus(block, state)) continue
    const lastLineEnd = state.doc.lineAt(Math.max(block.from, block.to - 1)).to
    if (open?.from === block.from) {
      ranges.push(
        Decoration.replace({
          widget: new ObjectEditorWidget(
            block,
            options.cheatSheet
          ),
          block: true
        }).range(block.from, lastLineEnd)
      )
      continue
    }
    const selected = blockIsSelected(state, block, gapHolder)
    const widget = slideTextRange
      ? new SlideTextObjectWidget(block, selected, blocks, slideTextRange)
      : isCardBlock(block)
        ? cardWidgetFor(block, selected, raw.has(block.from), expanded.has(block.from), statuses, previews)
        : widgetForObjectBlock(block, selected, raw.has(block.from), options.onZoom)
    // WriteFlex C1: selection is a widget class. The visual replacement ends at the final line's
    // END and never consumes its newline, which keeps CM6's tile geometry valid.
    const replacement = Decoration.replace({ widget, block: true })
    ranges.push(replacement.range(block.from, lastLineEnd))
    if (gapAfterWith(state, block, (pos) => starts.has(pos))) {
      // The object's end is a caret stop of its own (the gap under it), so the atomic range stops there.
      ranges.push(Decoration.widget({ widget: new ObjectGapWidget(gapHolder?.from === block.from), block: true, side: 1 }).range(lastLineEnd))
      atomicRanges.push(replacement.range(block.from, lastLineEnd))
      continue
    }
    // WriteFlex live-preview.ts:296-307: the atomic range extends over the trailing newline so a
    // single downward move steps fully past the block.
    atomicRanges.push(replacement.range(block.from, Math.min(state.doc.length, lastLineEnd + 1)))
  }

  // Inline comment chips: atomic over exactly `<!--` through `-->`; the text around them is untouched.
  const focus = currentFocusRange(state)
  for (const comment of objects.inline) {
    if (focus && (comment.from < focus.from || comment.to > focus.to)) continue
    const chip = Decoration.replace({ widget: new CommentChipWidget(comment) })
    ranges.push(chip.range(comment.from, comment.to))
    atomicRanges.push(chip.range(comment.from, comment.to))
  }
  // Constructs left as text: a warning mark, never a fold (an unclosed `<!--` or `:::notes`).
  for (const warning of objects.warnings) {
    if (focus && (warning.from < focus.from || warning.to > focus.to)) continue
    if (warning.to <= warning.from) continue
    ranges.push(Decoration.mark({
      class: 'tw-region-warning',
      attributes: {
        title: warning.kind === 'unclosed-notes'
          ? 'No closing ::: — everything down to the next slide heading is notes.'
          : 'This <!-- has no -->. It shows on the slide as text and, if a --> appears later, hides everything between.'
      }
    }).range(warning.from, warning.to))
    if (warning.kind === 'unclosed-notes' && typeof warning.closeAt === 'number') {
      ranges.push(Decoration.widget({ widget: new AddNotesCloseWidget(warning.from, warning.closeAt), side: 1 }).range(warning.to))
    }
  }

  return {
    blocks,
    decorations: Decoration.set(ranges, true),
    atomic: Decoration.set(atomicRanges, true)
  }
}

/** The inline comment chips and the region warnings of the current document (read by tests and commands). */
export function outlineObjectsIn(state: EditorState): OutlineObjects | undefined {
  return state.field(objectIndex, false)
}

/** Expand the card at the caret. Notes open directly in their editor. */
export function toggleExpandedObjectAtSelection(view: EditorView): boolean {
  const block = activeBlock(view.state)
  if (!block || blockIsOpen(view.state, block) || !isCardBlock(block)) return false
  if (block.kind === 'notes') return openSelectedObject(view)
  const expanded = view.state.field(expandedBlockField).has(block.from)
  view.dispatch({ effects: setExpandedObjectBlock.of({ from: block.from, expanded: !expanded }) })
  return true
}

/** What the commit check knows beyond the text: main's last answers about the files cards name. */
function commitFacts(view: EditorView): ObjectCommitFacts {
  const statuses = view.state.field(objectStatusField, false)
  return { statusOf: (ref) => statuses?.get(ref)?.state }
}

const objectBlocksField = StateField.define<ObjectBlockState>({
  create: buildObjectBlockState,
  update(value, transaction) {
    if (!transaction.docChanged && !transaction.selection && transaction.effects.length === 0 && !transaction.reconfigured) {
      return value
    }
    return buildObjectBlockState(transaction.state)
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(field).atomic)
  ]
})

export function objectBlocksIn(state: EditorState): ObjectBlock[] {
  return state.field(objectBlocksField, false)?.blocks ?? []
}

export function hasOpenObjectBlock(state: EditorState): boolean {
  return state.field(openBlockField, false) != null
}

/** Shared behavioural guard for every editor surface that can invoke inline formatting. */
export function canRunInlineFormatting(state: EditorState): boolean {
  return !hasOpenObjectBlock(state)
}

function activeBlock(state: EditorState): ObjectBlock | undefined {
  const head = state.selection.main.head
  const docLength = state.doc.length
  const gap = caretGapBlock(state)
  return objectBlocksIn(state).find((block) =>
    block.from !== gap?.from
    && blockIsInsideFocus(block, state)
    && head >= block.from
    && (head < block.to || (block.to >= docLength && head <= block.to))
  )
}

function blockIsOpen(state: EditorState, block: ObjectBlock): boolean {
  return state.field(openBlockField)?.from === block.from
}

/** The first command in the deterministic Enter chain: open a closed object or fall through. */
export function openSelectedObject(view: EditorView): boolean {
  const open = view.state.field(openBlockField, false)
  const head = view.state.selection.main.head
  // Enter on the line under an object that has none of its own: make that line (gap rule above).
  if (enterAtObjectGap(view)) return true
  // An Enter inside open source must remain a plain newline so table rows and outline nodes work.
  if (open && head >= open.from && head <= open.to) return false
  const block = activeBlock(view.state)
  if (!block) return false
  view.dispatch({
    selection: { anchor: block.from },
    effects: setOpenObjectBlock.of({ from: block.from, to: block.to }),
    scrollIntoView: true
  })
  return true
}

/** Backspace on a selected, closed object: delete it whole (the app's `editor.object-delete` key,
 *  keymap/registry.ts; the object keys below do the same where that keymap is not installed). */
export function deleteSelectedObject(view: EditorView): boolean {
  if (view.composing || view.compositionStarted) return false
  const sel = view.state.selection
  if (sel.ranges.length !== 1 || !sel.main.empty) return false
  const block = activeBlock(view.state)
  if (!block || blockIsOpen(view.state, block)) return false
  return deleteObjectBlock(view, block) || true
}

/** Enter at an object's gap: a blank line after the object, the caret on a new line below it. The
 *  newline is inserted at the gap as typed text is, and the object source guard puts the blank line before it. */
export function enterAtObjectGap(view: EditorView): boolean {
  if (view.composing || view.compositionStarted) return false
  const block = caretGapBlock(view.state)
  if (!block) return false
  const end = objectEnd(view.state, block)
  view.dispatch({
    changes: { from: end, insert: '\n' },
    selection: EditorSelection.cursor(end + 1),
    userEvent: 'input',
    scrollIntoView: true
  })
  return true
}

export function closeOpenObject(view: EditorView): boolean {
  const open = view.state.field(openBlockField)
  if (!open) return false
  const shell = (view as EditorView & { dom?: HTMLElement }).dom?.querySelector<HTMLElement>('.oe') as
    | (HTMLElement & {
      __twCommit?: (context?: ObjectEditorCommitContext) => ObjectEditorCommitResult
    })
    | null
    | undefined
  if (shell?.__twCommit) {
    shell.__twCommit('interactive')
    return true
  }
  view.dispatch({
    selection: { anchor: open.from },
    effects: setOpenObjectBlock.of(null),
    scrollIntoView: true
  })
  return true
}

export function toggleRawObjectAtSelection(view: EditorView): boolean {
  const block = activeBlock(view.state)
  if (!block || blockIsOpen(view.state, block)) return false
  const raw = view.state.field(rawBlockField).has(block.from)
  view.dispatch({ effects: setRawObjectBlock.of({ from: block.from, raw: !raw }) })
  return true
}

// ── The object source guard ──────────────────────────────────────────────────────────────────────
// A rule on the document change itself, whatever made it (a key, a paste event or the Paste command,
// an input method, a drop, an object or snippet insert, Find and Replace, a Scratchpad insert, any
// command that inserts at the selection), so no way in can put text onto an object's lines:
//
//   1. Text that would go in at the end of a closed object's last line (its closing fence, its `:::`,
//      `-->`, last table row, last list item or page line; the gap under the object is that place) goes
//      on a line of its own after the object instead, with one blank line between: `\n\n` goes in
//      front of it, or `\n` when it already starts with a line break, nothing when it already starts
//      with a blank line. With the caret in the gap (typing, Enter, pasting there) a text that starts
//      with one line break gets the blank line too.
//   2. A deletion from that place that would pull the next line up onto the object's last line keeps
//      the line break.
//   3. Text that would go in at the very start of a closed object without a line break of its own
//      (a paste or an insert with the object selected) goes after the object as in 1, as typing does.
//   4. One change of a transaction that would break an object's opening or closing marker is taken
//      out of the transaction, and every other change in it applies (a Replace All, a multi-cursor
//      edit, a line command). Nothing else is refused: a change inside an object's body is ordinary
//      text, and a change that deletes or replaces a whole object (from its start to the end of its
//      last line, or beyond) is allowed. "Breaks" is exactly (breaksObjectMarker below):
//      a. Opening marker (a fence's run of ``` or ~~~, `:::`, `<!--`, `[Embed:`, `[Simulation:` or
//         `[Video:` at the start of the object's first line): the change deletes or replaces any of
//         its characters, or puts text strictly inside it, or leaves anything but spaces and tabs in
//         front of it on its line (a prefix such as `- ` or `## `, or its line joined onto the line
//         above). Text put in at the very start of the object is not such a prefix: rule 3 moves it.
//      b. A trigger list's token (`{table}`, `{mindmap}`, on its own line or a title): the change
//         edits part of the token, not all of it. (Removing the token whole turns the object into a
//         plain list, which is the author's to choose.)
//      c. Closing marker (a fence's or a notes block's closing line, with the line break before it,
//         or a comment's `-->`): the change deletes or replaces any of it, or puts text into it (in
//         front of a closing fence, inside the marker). Text at its end is rule 1's.
//      Objects with no marker (a pipe table, a bare address) have nothing to break. When in doubt the
//      change applies: the author asked for it, and Undo is there.
//
//   Line commands (a list, a heading level, indenting, quoting, moving, copying or deleting a line)
//   never reach an object's lines: runLineCommand below makes the line under the object first when the
//   caret is in the gap, and does nothing when the object itself is selected.
//
// Rules 1 to 3 add one change to the same transaction, so it is one undo step with the change it
// fixes, and Undo restores the text exactly. Left alone: Undo and Redo (they restore what was there),
// the open object's own editor (it writes its planned source), and writes that must give an exact
// text (exactTextWrite: a disk version, a save's stamped text, a planned whole-text rewrite).

/** The last object starting at or before `pos` (the index is sorted by start). */
function objectAtOrBefore(blocks: readonly ObjectBlock[], pos: number): ObjectBlock | undefined {
  let lo = 0
  let hi = blocks.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (blocks[mid].from <= pos) { found = mid; lo = mid + 1 } else hi = mid - 1
  }
  return found < 0 ? undefined : blocks[found]
}

const startsWithBreak = (text: string): number => text.startsWith('\r\n') ? 2 : text.startsWith('\n') || text.startsWith('\r') ? 1 : 0

/** What goes in front of `text` put in at an object's end (rule 1 and 2 above), or '' for nothing. */
function leadAtObjectEnd(state: EditorState, text: string, toA: number, caretInGap: boolean): string {
  if (!text) {
    // A deletion from the object's end: fine unless it brings text up onto the object's line.
    if (toA >= state.doc.length) return ''
    return startsWithBreak(state.doc.sliceString(toA, toA + 2)) ? '' : '\n'
  }
  const first = startsWithBreak(text)
  if (!first) return '\n\n'
  if (startsWithBreak(text.slice(first))) return ''
  return caretInGap ? '\n' : ''
}

/** Where a closing marker starts on the object's last line (a fence's or a notes block's closing line,
 *  a comment's `-->`), or null for an object that ends in content (a table row, a list item, a page). */
function closingMarkerStart(state: EditorState, block: ObjectBlock, end: number): number | null {
  const last = state.doc.lineAt(end)
  if (block.kind === 'comment') {
    const at = last.text.lastIndexOf('-->')
    return at < 0 ? null : last.from + at
  }
  if (block.bodyTo === undefined && block.kind !== 'notes') return null
  if (last.from <= block.from) return null
  return last.from + (/^[ \t]*/.exec(last.text)?.[0].length ?? 0)
}

/** An opening marker: where it is, the line it is on, and whether text in front of it breaks it. */
type OpeningMarker = { lineFrom: number; from: number; to: number; prefixBreaks: boolean }

const OPENING_MARKER = /^[ \t]*(`{3,}|~{3,}|:::|<!--|\[(?:Embed|Simulation|Video):)/

function openingMarker(state: EditorState, block: ObjectBlock): OpeningMarker | null {
  if (block.triggerLine && block.triggerToken) {
    if (block.triggerLine > state.doc.lines) return null
    const line = state.doc.line(block.triggerLine)
    const token = [...parseTriggerLine(line.text)].reverse().find((candidate) => candidate.raw === block.triggerToken)
    return token ? { lineFrom: line.from, from: line.from + token.start, to: line.from + token.end, prefixBreaks: false } : null
  }
  const line = state.doc.lineAt(block.from)
  if (line.from !== block.from) return null
  const match = OPENING_MARKER.exec(line.text)
  if (!match) return null
  const from = line.from + match[0].length - match[1].length
  return { lineFrom: line.from, from, to: from + match[1].length, prefixBreaks: true }
}

/** Rule 4: does this one change (old-document range and its new text) break `block`'s markers? */
function breaksObjectMarker(state: EditorState, block: ObjectBlock, end: number, fromA: number, toA: number, inserted: Text): boolean {
  if (fromA <= block.from && toA >= end) return false
  const opening = openingMarker(state, block)
  if (opening) {
    if (opening.prefixBreaks) {
      if (fromA < opening.to && toA > opening.from) return true
    } else if (fromA < opening.to && toA > opening.from && !(fromA <= opening.from && toA >= opening.to)) return true
    if (fromA === toA && fromA > opening.from && fromA < opening.to) return true
    if (opening.prefixBreaks && toA <= opening.from && toA >= opening.lineFrom && !(fromA === toA && fromA === block.from)) {
      // What stands in front of the marker on its line afterwards.
      const lastLine = inserted.line(inserted.lines).text
      const before = (inserted.lines > 1 ? '' : state.doc.sliceString(state.doc.lineAt(fromA).from, fromA))
        + lastLine + state.doc.sliceString(toA, opening.from)
      if (/\S/.test(before)) return true
    }
  }
  const marker = closingMarkerStart(state, block, end)
  if (marker === null) return false
  // A closing line is protected whole, indentation included, together with the line break before it: a change
  // that removes that break joins the closing marker onto the body's last line, and the object no longer closes.
  // (A comment's `-->` sits inside its line; there only the marker itself is protected.)
  const lineFrom = block.kind === 'comment' ? marker : state.doc.lineAt(marker).from
  const from = lineFrom > 0 && state.doc.sliceString(lineFrom - 1, lineFrom) === '\n' ? lineFrom - 1 : lineFrom
  return fromA === toA ? fromA > from && fromA < end : fromA < end && toA > from
}

/** The changes rule 4 took out of the last filtered transaction, for the Replace All count (rule 5). */
let heldBack: { state: EditorState; count: number } | null = null

/** Rule 4: the ranges (old document) of the changes that would break an object's marker, suppressed. */
const objectSourceChangeGuard = EditorState.changeFilter.of((tr) => {
  if (tr.isUserEvent('undo') || tr.isUserEvent('redo') || tr.annotation(exactTextWrite)) return true
  const start = tr.startState
  const blocks = start.field(objectIndex, false)?.blocks
  if (!blocks?.length) return true
  const open = start.field(openBlockField, false)
  const suppressed: number[] = []
  const suppress = (from: number, to: number) => {
    const last = suppressed.length - 1
    if (last > 0 && suppressed[last] >= from) suppressed[last] = Math.max(suppressed[last], to)
    else suppressed.push(from, to)
  }
  // Each change is judged on its own (`individual`): CodeMirror otherwise hands touching changes over as one
  // range, and an allowed replacement next to a protected one (a fence's info string beside its backticks)
  // would be held back with it.
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    // The objects this change can reach: those starting at or before its end, back to the first one
    // ending before its start (objects never overlap, so the walk stops there), and the next one when
    // its trigger line is in reach.
    let lo = 0
    let hi = blocks.length - 1
    let index = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (blocks[mid].from <= toA) { index = mid; lo = mid + 1 } else hi = mid - 1
    }
    const next = blocks[index + 1]
    const reach = next?.triggerLine && next.triggerLine <= start.doc.lines && start.doc.line(next.triggerLine).from <= toA
      ? index + 1
      : index
    for (let at = reach; at >= 0; at -= 1) {
      const block = blocks[at]
      const end = objectEnd(start, block)
      if (end < fromA && at <= index) break
      if (block.kind === 'notes' && start.facet(editNotesAsSource)) continue
      if (open?.from === block.from) continue
      if (!breaksObjectMarker(start, block, end, fromA, toA, inserted)) continue
      // A pure insertion is suppressed by a range around it (CodeMirror keeps an insertion at a range's edge).
      if (fromA === toA) suppress(Math.max(0, fromA - 1), Math.min(start.doc.length, fromA + 1))
      else suppress(fromA, toA)
      break
    }
  }, true)
  if (!suppressed.length) return true
  if (tr.effects.some((effect) => effect.is(EditorView.announce))) {
    let count = 0
    tr.changes.iterChanges((fromA, toA) => {
      for (let i = 0; i < suppressed.length; i += 2) {
        if (fromA >= suppressed[i] && toA <= suppressed[i + 1] && (fromA < toA || (fromA > suppressed[i] && fromA < suppressed[i + 1]))) { count += 1; break }
      }
    }, true)
    heldBack = { state: start, count }
  }
  return suppressed
})

/** Rule 5: a Replace All that rule 4 held some matches back from announces the number it replaced. */
function withReplacedCount(tr: Transaction): Transaction | TransactionSpec {
  const held = heldBack
  if (!held || held.state !== tr.startState) return tr
  heldBack = null
  let changed = false
  const effects = tr.effects.map((effect) => {
    if (!effect.is(EditorView.announce)) return effect
    const announced = /\d+/.exec(effect.value)
    if (!announced) return effect
    changed = true
    const replaced = Math.max(0, Number(announced[0]) - held.count)
    const kept = held.count === 1
      ? '1 was left as it was: replacing it would break an object'
      : `${held.count} were left as they were: replacing them would break an object`
    return EditorView.announce.of(`${tr.startState.phrase('replaced $ matches', replaced)}. ${kept}.`)
  })
  if (!changed) return tr
  const userEvent = tr.annotation(Transaction.userEvent)
  const addToHistory = tr.annotation(Transaction.addToHistory)
  const isolate = tr.annotation(isolateHistory)
  return {
    changes: tr.changes,
    selection: tr.selection,
    effects,
    scrollIntoView: tr.scrollIntoView,
    ...(userEvent !== undefined ? { userEvent } : {}),
    annotations: [
      ...(addToHistory !== undefined ? [Transaction.addToHistory.of(addToHistory)] : []),
      ...(isolate !== undefined ? [isolateHistory.of(isolate)] : [])
    ]
  }
}

const objectSourceGuard = EditorState.transactionFilter.of((tr) => {
  const base = withReplacedCount(tr)
  if (!tr.docChanged || tr.isUserEvent('undo') || tr.isUserEvent('redo') || tr.annotation(exactTextWrite)) return base
  const start = tr.startState
  const blocks = start.field(objectIndex, false)?.blocks
  if (!blocks?.length) return base
  const open = start.field(openBlockField, false)
  const gap = caretGapBlock(start)
  const fixes: Array<{ from: number; to?: number; insert?: string }> = []
  let caret: number | null = null
  const newHead = tr.newSelection.main.head
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    const block = objectAtOrBefore(blocks, fromA)
    if (!block || open?.from === block.from) return
    const end = objectEnd(start, block)
    if (fromA === end) {
      // The closing line keeps its after-block insertion rule even when notes show as source.
      // The first characters say all the rule needs (a large paste is not copied out).
      const text = inserted.sliceString(0, 4)
      const typedHere = gap?.from === block.from && fromA === toA && newHead > fromB && newHead <= toB
      const lead = leadAtObjectEnd(start, text, toA, typedHere)
      if (lead) fixes.push({ from: fromB, insert: lead })
      return
    }
    if (block.kind === 'notes' && start.facet(editNotesAsSource)) return
    if (fromA === block.from && fromA === toA && inserted.length > 0 && end > fromA) {
      const text = inserted.toString()
      if (/[\r\n]$/.test(text)) return
      // Move it after the object, as typing on a selected object does (typeEscape).
      const after = tr.changes.mapPos(end, 1)
      const lead = '\n\n'
      fixes.push({ from: fromB, to: toB }, { from: after, insert: lead + text })
      // After the deletion above it, the moved text starts at `after - text.length`; the caret goes after it.
      if (newHead === toB) caret = after + lead.length
    }
  })
  if (!fixes.length) return base
  fixes.sort((a, b) => a.from - b.from)
  return [base, {
    changes: fixes,
    sequential: true,
    ...(caret !== null && tr.newSelection.ranges.length === 1 ? { selection: EditorSelection.cursor(caret) } : {}),
    scrollIntoView: tr.scrollIntoView
  }]
})

// Editing raw source may change a note's contents, or replace its entire marked block. A partial
// edit must keep the existing delimiters paired and every line between them private.
const refusedRawNotesEdit = StateEffect.define<string>()
const rawNotesGuard = EditorState.transactionFilter.of(tr => {
  const start = tr.startState
  if (!tr.docChanged || !start.facet(editNotesAsSource) || tr.isUserEvent('undo')
    || tr.isUserEvent('redo') || tr.annotation(exactTextWrite)) return tr
  const blocks = objectBlockIndex.read(start).filter(block => block.kind === 'notes')
  const partial = blocks.filter(block => {
    const end = objectEnd(start, block)
    let touched = false
    let replaced = false
    tr.changes.iterChangedRanges((from, to) => {
      if (from <= block.from && to >= end) replaced = true
      if (from <= end && to >= block.from) touched = true
    })
    return touched && !replaced
  })
  if (!partial.length) return tr
  const text = tr.newDoc.toString()
  const regions = readOutlineObjectRegions(text)
  const privateLines = compilerNotesLines(text)
  const stillPrivate = partial.every(block => {
    const close = start.doc.lineAt(objectEnd(start, block)).from
    const openingLine = tr.newDoc.lineAt(tr.changes.mapPos(block.from, 1)).number - 1
    const closingLine = tr.newDoc.lineAt(tr.changes.mapPos(close, 1)).number - 1
    if (!regions.notes.some(note => note.closed && note.start === openingLine && note.close === closingLine)) return false
    for (let line = openingLine; line <= closingLine; line += 1) {
      if (!privateLines.has(line)) return false
    }
    return true
  })
  if (stillPrivate) return tr
  const message = 'Paste the whole block to add a code fence, comment or ::: line inside notes.'
  return { effects: [EditorView.announce.of(message), refusedRawNotesEdit.of(message)] }
})

/** The object that typed text at the caret must go after: the one whose gap holds the caret, or the
 *  closed object the caret selects (the browser's own caret sits beside its block, so its text would
 *  land on the line above). */
function typingTarget(state: EditorState): ObjectBlock | null {
  const gap = caretGapBlock(state)
  if (gap) return gap
  const sel = state.selection
  if (sel.ranges.length !== 1 || !sel.main.empty) return null
  const block = activeBlock(state)
  return block && !blockIsOpen(state, block) ? block : null
}

/** An input method starting to compose in an object's gap (or on a selected object): make the line first (a blank line after the
 *  object, the caret on a new line under it), so the composition happens on a real line and never on
 *  the object's last line. The composed text then joins this change's undo step (CodeMirror joins
 *  composition to the step before it), so one Undo restores the text as it was. */
export function materialiseGapLine(view: EditorView): boolean {
  const { state } = view
  let block = typingTarget(state)
  const { main, ranges } = state.selection
  if (!block && state.facet(editNotesAsSource) && ranges.length === 1 && main.empty) {
    // Start composition below the visible closer even if a later line already exists.
    // Redirecting each provisional IME edit separately can leave extra composed characters.
    const candidate = objectAtOrBefore(objectBlockIndex.read(state), main.head)
    if (candidate?.kind === 'notes' && main.head === objectEnd(state, candidate)) block = candidate
  }
  if (!block) return false
  const end = objectEnd(state, block)
  view.dispatch({
    changes: { from: end, insert: '\n\n' },
    selection: EditorSelection.cursor(end + 2),
    userEvent: 'input.type',
    annotations: isolateHistory.of('before'),
    scrollIntoView: true
  })
  return true
}

/** A command that works on "the caret's line" (a list, a heading level, indenting, quoting, moving,
 *  copying or deleting a line), run so that it never acts on an object's lines (rule 4's companion):
 *  - with the caret at the end of a closed object's last line (the gap under it), the line under the
 *    object is made first (a blank line, then the caret's new line, as typing there does) and the
 *    command acts on that line; what it writes and the new line are one change, one undo step, and
 *    when the command changes nothing, nothing is written;
 *  - with a closed object selected, it does nothing (the object is not a line to act on);
 *  - anywhere else it runs as it is. */
export function runLineCommand(view: EditorView, run: (view: EditorView) => boolean): boolean {
  const target = view.composing ? null : lineCommandTarget(view.state)
  if (target?.at === 'gap') return runOnLineAfterObject(view, target.end, run)
  if (target?.at === 'object') return true
  return run(view)
}

/** Whether a line command has nothing to act on at the caret: a closed object is selected. The action
 *  bar shows its line controls (lists, heading levels) as unavailable then. */
export function lineCommandUnavailable(state: EditorState): boolean {
  return lineCommandTarget(state)?.at === 'object'
}

/** With one empty caret: at the end of a closed object's last line (the gap under it, or the end of
 *  that line when a line follows), or on a selected closed object. One lookup, no scan. */
function lineCommandTarget(state: EditorState): { at: 'gap'; end: number } | { at: 'object' } | null {
  const blocks = cardsIn(state)
  const sel = state.selection
  if (!blocks?.length || sel.ranges.length !== 1 || !sel.main.empty) return null
  const head = sel.main.head
  const block = objectAtOrBefore(blocks, head)
  if (!block || state.field(openBlockField, false)?.from === block.from || !blockIsInsideFocus(block, state)) return null
  const end = objectEnd(state, block)
  if (head === end) return { at: 'gap', end }
  // As activeBlock reads a selected object.
  return head < block.to || (block.to >= state.doc.length && head <= block.to) ? { at: 'object' } : null
}

function runOnLineAfterObject(view: EditorView, end: number, run: (view: EditorView) => boolean): boolean {
  const made = view.state.update({ changes: { from: end, insert: '\n\n' }, selection: EditorSelection.cursor(end + 2) })
  let current = made.state
  const steps: Transaction[] = []
  const take = (tr: Transaction) => { steps.push(tr); current = tr.state }
  // The command sees the state with the new line and its dispatches are collected, not applied. The
  // screen has no new line yet, so what it asks about the layout there is answered plainly: a caret
  // moved by line stays where it is (deleting a line asks where the caret goes next), no coordinates.
  const unmoved = { value: (range: SelectionRange) => range }
  const onNewLine = Object.create(view, {
    state: { get: () => current },
    lineWrapping: { get: () => false },
    moveVertically: unmoved,
    moveByChar: unmoved,
    moveByGroup: unmoved,
    moveToLineBoundary: unmoved,
    coordsAtPos: { value: () => null },
    coordsForChar: { value: () => null },
    dispatch: {
      value: (...args: unknown[]) => {
        if (args[0] instanceof Transaction) for (const tr of args as Transaction[]) take(tr)
        else if (Array.isArray(args[0])) for (const tr of args[0] as Transaction[]) take(tr)
        else take(current.update(...(args as TransactionSpec[])))
      }
    }
  }) as EditorView
  let handled: boolean
  try {
    handled = run(onNewLine)
  } catch (error) {
    // A command that cannot run on the new line writes nothing.
    console.warn('A line command could not run on the line under an object:', error)
    return true
  }
  // Nothing written (or the text as it was, as moving one empty line past another leaves it): nothing happens.
  if (!steps.some((tr) => tr.docChanged) || current.doc.eq(made.state.doc)) return handled
  let changes = made.changes
  for (const tr of steps) changes = changes.compose(tr.changes)
  // Each step's effects, mapped through the steps after it.
  const effects: StateEffect<unknown>[] = []
  let later: ChangeSet | null = null
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    effects.unshift(...(later ? StateEffect.mapEffects(steps[i].effects, later) : steps[i].effects))
    later = later ? steps[i].changes.compose(later) : steps[i].changes
  }
  const userEvent = steps.map((tr) => tr.annotation(Transaction.userEvent)).find(Boolean) ?? 'input'
  // Each step went through the filters already (on the state it was made on), so the sum does not again.
  view.dispatch({
    changes,
    selection: current.selection,
    effects,
    userEvent,
    annotations: isolateHistory.of('full'),
    scrollIntoView: true,
    filter: false
  })
  return true
}

const objectBlockEvents = EditorView.domEventHandlers({
  compositionstart(_event, view) {
    materialiseGapLine(view)
    return false
  },
  // Text typed at an object's gap or on a selected object: the browser would put it wherever its own
  // selection sits beside the object's block (on a selected object, the line above it), so the key's
  // text is inserted at the end of the object here (the object source guard then makes its line).
  beforeinput(event, view) {
    if (event.inputType !== 'insertText' || !event.data || view.composing || view.compositionStarted) return false
    const block = typingTarget(view.state)
    if (!block) return false
    event.preventDefault()
    const end = objectEnd(view.state, block)
    view.dispatch({
      changes: { from: end, insert: event.data },
      selection: EditorSelection.cursor(end + event.data.length),
      userEvent: 'input.type'
    })
    return true
  },
  mousedown(event, view) {
    const gap = (event.target as HTMLElement | null)?.closest<HTMLElement>('.tw-obj-gap')
    if (gap) {
      view.dispatch({ selection: EditorSelection.cursor(view.posAtDOM(gap)), userEvent: 'select.pointer' })
      view.focus()
      event.preventDefault()
      return true
    }
    const element = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-object-block]')
    if (!element) return false
    const position = view.posAtDOM(element)
    // WriteFlex C4: use event.detail here. A separate dblclick handler sees the old widget after
    // the first click's selected-state re-render detaches it.
    const block = event.detail >= 2
      ? objectBlocksIn(view.state).find((candidate) =>
        position >= candidate.from && position <= candidate.to
      )
      : undefined
    if (block) {
      view.dispatch({
        selection: { anchor: block.from },
        effects: setOpenObjectBlock.of({ from: block.from, to: block.to })
      })
    } else {
      view.dispatch({ selection: { anchor: position } })
    }
    view.focus()
    return true
  }
})

// The gap's look lives with it, so it holds wherever the field is used: one empty line's height, the
// text cursor, and (when it holds the caret) a caret drawn at the text's left edge in place of
// CodeMirror's own, which has no line there to stand on.
const gapTheme = EditorView.baseTheme({
  '.tw-obj-gap': { position: 'relative', height: '1.6em', cursor: 'text' },
  '&.cm-focused .tw-obj-gap.is-caret::before': {
    content: '""', position: 'absolute', top: '.25em', bottom: '.25em', left: '6px',
    borderLeft: '1.2px solid currentColor', animation: 'tw-obj-gap-blink 1.2s steps(1) infinite'
  },
  '&:has(.tw-obj-gap.is-caret) .cm-cursorLayer .cm-cursor': { display: 'none' },
  '@keyframes tw-obj-gap-blink': { '50%': { opacity: '0' } }
})

export function objectBlocksExtension(options: ObjectBlocksOptions): Extension {
  // Typing while a CLOSED widget is selected must not corrupt the object's source. The text lands
  // in a new blank-line-separated paragraph below it (WriteFlex walk finding, 2026-07-12).
  const typeEscape = EditorView.inputHandler.of((view, from, _to, text) => {
    if (caretGapBlock(view.state)) return false
    const block = objectBlocksIn(view.state).find((candidate) =>
      blockIsInsideFocus(candidate, view.state)
      && from >= candidate.from
      && from < candidate.to
    )
    if (!block) return false
    if (blockIsOpen(view.state, block)) return false
    // At the end of the object's last line; the object source guard puts it on a line of its own after
    // a blank line. (Inserting after `to` instead joined it to the next line when `to` took in the
    // object's line break, as a fence's does.)
    const insertAt = objectEnd(view.state, block)
    view.dispatch({
      changes: { from: insertAt, insert: text },
      selection: { anchor: insertAt + text.length },
      userEvent: 'input',
      scrollIntoView: true
    })
    return true
  })

  // Keep typed source on cancellation. Only a chosen object consumes the mapped trigger range.
  const fenceTrigger = EditorView.inputHandler.of((view, from, to, text) => {
    if (text !== '`' || !options.onInsertMenu) return false
    const line = view.state.doc.lineAt(from)
    if (view.state.doc.sliceString(line.from, from) !== '``') return false
    if (view.state.doc.sliceString(to, line.to).trim() !== '') return false
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + 1 },
      effects: setInsertFence.of({ from: line.from, to: from + 1 }),
      userEvent: 'input'
    })
    const coords = view.coordsAtPos(line.from)
    if (coords) options.onInsertMenu({ x: coords.left, y: coords.bottom + 4 }, (replace) => {
      const fence = view.state.field(insertFenceField)
      // A direct object insertion replaces the trigger in its own document transaction.
      if (replace) { replace(fence ?? undefined); return }
      if (!fence) return
      view.dispatch({
        changes: { from: fence.from, to: fence.to },
        selection: { anchor: fence.from },
        effects: setInsertFence.of(null),
        annotations: isolateHistory.of('before'),
        userEvent: 'input'
      })
    })
    return true
  })

  /** The closed object right after the line break at `pos` (the caret at the end of the line above it). */
  const objectStartingAfter = (state: EditorState, pos: number): ObjectBlock | undefined =>
    objectBlocksIn(state).find((block) => block.from === pos + 1 && !blockIsOpen(state, block) && blockIsInsideFocus(block, state))
  /** The closed object whose last line ends just before `pos` (the caret at the start of the line after it). */
  const objectEndingBefore = (state: EditorState, pos: number): ObjectBlock | undefined =>
    objectBlocksIn(state).find((block) => pos > 0 && objectEnd(state, block) === pos - 1 && !blockIsOpen(state, block) && blockIsInsideFocus(block, state))
  const caret = (view: EditorView, pos: number): boolean => {
    view.dispatch({ selection: EditorSelection.cursor(pos), scrollIntoView: true, userEvent: 'select' })
    return true
  }
  const emptyCaret = (state: EditorState): number | null =>
    state.selection.ranges.length === 1 && state.selection.main.empty ? state.selection.main.head : null

  // shortcut-id: editor.object-delete
  // The selected object, the gap under it and the lines either side: the arrows reach the gap, and
  // Backspace or Delete either select the object (the first press next to it) or delete it whole (a
  // press on the selected object). A key never joins a line onto an object's first or last line.
  const objectKeys = Prec.highest(keymap.of([
    {
      key: 'ArrowDown',
      run(view) {
        const state = view.state
        const gap = caretGapBlock(state)
        if (gap) {
          const end = objectEnd(state, gap)
          return end < state.doc.length ? caret(view, end + 1) : true
        }
        const block = emptyCaret(state) === null ? undefined : activeBlock(state)
        if (!block || blockIsOpen(state, block) || !blockHasGap(state, block.from)) return false
        return caret(view, objectEnd(state, block))
      }
    },
    {
      key: 'ArrowUp',
      run(view) {
        const state = view.state
        const gap = caretGapBlock(state)
        if (gap) return caret(view, gap.from)
        const head = emptyCaret(state)
        if (head === null) return false
        const lineFrom = state.doc.lineAt(head).from
        const above = objectEndingBefore(state, lineFrom)
        if (!above || !blockHasGap(state, above.from)) return false
        return caret(view, lineFrom - 1)
      }
    },
    {
      key: 'ArrowLeft',
      run(view) {
        const gap = caretGapBlock(view.state)
        return gap ? caret(view, gap.from) : false
      }
    },
    {
      key: 'ArrowRight',
      run(view) {
        const state = view.state
        const gap = caretGapBlock(state)
        if (gap) {
          const end = objectEnd(state, gap)
          return end < state.doc.length ? caret(view, end + 1) : true
        }
        const block = emptyCaret(state) === null ? undefined : activeBlock(state)
        if (!block || blockIsOpen(state, block) || !blockHasGap(state, block.from)) return false
        return caret(view, objectEnd(state, block))
      }
    },
    {
      key: 'Backspace',
      run(view) {
        const state = view.state
        const head = emptyCaret(state)
        if (head === null || view.composing || view.compositionStarted) return false
        const gap = caretGapBlock(state)
        if (gap) return caret(view, gap.from)
        const selected = activeBlock(state)
        if (selected && !blockIsOpen(state, selected)) return deleteObjectBlock(view, selected) || true
        const line = state.doc.lineAt(head)
        if (head !== line.from) return false
        const above = objectEndingBefore(state, line.from)
        if (!above) return false
        if (blockHasGap(state, above.from)) return caret(view, line.from - 1)
        if (line.text.trim() === '') {
          // An empty line under an object: Backspace takes the empty line, not the object's last line.
          view.dispatch({
            changes: { from: line.from - 1, to: line.from },
            selection: EditorSelection.cursor(line.from - 1),
            userEvent: 'delete.backward',
            scrollIntoView: true
          })
          if (!caretGapBlock(view.state)) caret(view, above.from)
          return true
        }
        return caret(view, above.from)
      }
    },
    {
      key: 'Delete',
      run(view) {
        const state = view.state
        const head = emptyCaret(state)
        if (head === null || view.composing || view.compositionStarted) return false
        if (caretGapBlock(state)) return true
        const selected = activeBlock(state)
        if (selected && !blockIsOpen(state, selected)) return deleteObjectBlock(view, selected) || true
        const line = state.doc.lineAt(head)
        if (head !== line.to) return false
        const below = objectStartingAfter(state, line.to)
        return below ? caret(view, below.from) : false
      }
    }
  ]))

  // shortcut-id: browser.move editor.protect-heading-delete
  // (ArrowDown and ArrowRight from an object at the end of the talk go to its gap: objectKeys above.
  // They used to write two newlines at the end of the talk.)
  const interactions = Prec.high(keymap.of([
    {
      key: 'ArrowUp',
      run(view) {
        const block = activeBlock(view.state)
        if (!block || blockIsOpen(view.state, block) || block.from !== 0) return false
        view.dispatch({
          changes: { from: 0, insert: '\n\n' },
          selection: { anchor: 0 },
          userEvent: 'input',
          scrollIntoView: true
        })
        return true
      }
    },
    {
      key: 'Backspace',
      run(view) {
        if (!view.state.selection.main.empty) return false
        const head = view.state.selection.main.head
        const block = objectBlocksIn(view.state).find((candidate) =>
          blockIsInsideFocus(candidate, view.state) && candidate.to === head
        )
        return Boolean(block && !blockIsOpen(view.state, block))
      }
    }
  ]))

  return [
    typeEscape,
    objectSourceChangeGuard,
    // CodeMirror applies transaction filters in reverse order. Validate the raw note
    // after the closing-line insertion has been placed next to it.
    rawNotesGuard,
    objectSourceGuard,
    EditorView.updateListener.of(update => {
      for (const transaction of update.transactions) {
        const refusal = transaction.effects.find(effect => effect.is(refusedRawNotesEdit))
        if (refusal) notify(refusal.value, 'warning', 'notes-source-boundary')
      }
    }),
    objectKeys,
    fenceTrigger,
    insertFenceField,
    objectIndex,
    openBlockField,
    rawBlockField,
    expandedBlockField,
    objectStatusField,
    objectBlocksOptions.of(options),
    objectBlocksField,
    objectBlockEvents,
    gapTheme,
    interactions
  ]
}
