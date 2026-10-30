import { isolateHistory } from '@codemirror/commands'
import {
  EditorState,
  Facet,
  Prec,
  StateField,
  StateEffect,
  type StateEffectType,
  type Extension,
  type Range
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  WidgetType,
  keymap,
  type DecorationSet
} from '@codemirror/view'
import { currentFocusRange } from '../focusScope.ts'
import { notify } from '../../lib/notify.ts'
import {
  detectObjectBlocks,
  detectOutlineObjects,
  type ObjectBlock,
  type OutlineObjects
} from './detect.ts'
import { setExpandedObjectBlock, setOpenObjectBlock, setRawObjectBlock } from './effects.ts'
import { widgetForObjectBlock } from './widgets.ts'
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

export { setExpandedObjectBlock, setOpenObjectBlock, setRawObjectBlock } from './effects.ts'

export type ObjectBlocksOptions = {
  onInsertMenu?: (coords: { x: number; y: number }, consumeFence: () => void) => void
  onZoom?: (block: ObjectBlock) => void
  cheatSheet?: ShellCheatSheet
}

// Parsing depends on the immutable document, not the cursor or object UI state. Share one
// index across all fields so a single edit cannot trigger several complete outline scans.
const objectIndex = StateField.define<OutlineObjects>({
  create: (state) => detectOutlineObjects(state.doc.toString()),
  update: (objects, transaction) => transaction.docChanged
    ? detectOutlineObjects(transaction.newDoc.toString())
    : objects
})

/** The block objects of the shared index (the field name every reader below used before cards). */
const objectBlockIndex = {
  read: (state: EditorState): ObjectBlock[] => state.field(objectIndex).blocks
}

const openBlockField = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(value, transaction) {
    const effect = transaction.effects.find((candidate) => candidate.is(setOpenObjectBlock))
    if (effect) return effect.value
    if (!value || !transaction.docChanged) return value
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

function blockIsSelected(state: EditorState, block: ObjectBlock): boolean {
  const docLength = state.doc.length
  return state.selection.ranges.some(({ head }) =>
    head >= block.from && (head < block.to || (block.to >= docLength && head <= block.to))
  )
}

function blockIsInsideFocus(block: ObjectBlock, state: EditorState): boolean {
  const focus = currentFocusRange(state)
  if (!focus) return true
  // The focus field describes the visible band. Any object that crosses into either hidden band
  // is omitted so its block replacement never overlaps Slide Focus's own hiding replacements.
  return block.from >= focus.from && block.to <= focus.to
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
  const blocks = objectBlockIndex.read(state)
  const open = state.field(openBlockField)
  const raw = state.field(rawBlockField)
  const expanded = state.field(expandedBlockField)
  const statuses = state.field(objectStatusField, false) ?? new Map<string, CardFileStatus>()
  const options = state.facet(objectBlocksOptions)
  const objects = state.field(objectIndex)
  const ranges: Array<Range<Decoration>> = []
  const atomicRanges: Array<Range<Decoration>> = []

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
    const selected = blockIsSelected(state, block)
    const widget = isCardBlock(block)
      ? cardWidgetFor(block, selected, raw.has(block.from), expanded.has(block.from), statuses)
      : widgetForObjectBlock(block, selected, raw.has(block.from), options.onZoom)
    // WriteFlex C1: selection is a widget class. The visual replacement ends at the final line's
    // END and never consumes its newline, which keeps CM6's tile geometry valid.
    const replacement = Decoration.replace({ widget, block: true })
    ranges.push(replacement.range(block.from, lastLineEnd))
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

/** Toggle the expanded preview of the card at the caret (session chrome; writes nothing). */
export function toggleExpandedObjectAtSelection(view: EditorView): boolean {
  const block = activeBlock(view.state)
  if (!block || blockIsOpen(view.state, block) || !isCardBlock(block)) return false
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
    if (!transaction.docChanged && !transaction.selection && transaction.effects.length === 0) {
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
  return objectBlocksIn(state).find((block) =>
    blockIsInsideFocus(block, state)
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

const objectBlockEvents = EditorView.domEventHandlers({
  mousedown(event, view) {
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

export function objectBlocksExtension(options: ObjectBlocksOptions): Extension {
  // Typing while a CLOSED widget is selected must not corrupt the object's source. The text lands
  // in a new blank-line-separated paragraph below it (WriteFlex walk finding, 2026-07-12).
  const typeEscape = EditorView.inputHandler.of((view, from, _to, text) => {
    const block = objectBlocksIn(view.state).find((candidate) =>
      blockIsInsideFocus(candidate, view.state)
      && from >= candidate.from
      && from < candidate.to
    )
    if (!block) return false
    if (blockIsOpen(view.state, block)) return false
    const insertAt = Math.min(block.to, view.state.doc.length)
    const needsGap = view.state.doc.sliceString(
      insertAt,
      Math.min(insertAt + 1, view.state.doc.length)
    ) !== '\n'
    const lead = insertAt >= view.state.doc.length || needsGap ? '\n\n' : '\n'
    view.dispatch({
      changes: { from: insertAt, insert: `${lead}${text}` },
      selection: { anchor: insertAt + lead.length + text.length },
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
    if (coords) options.onInsertMenu({ x: coords.left, y: coords.bottom + 4 }, () => {
      const fence = view.state.field(insertFenceField)
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

  // shortcut-id: browser.move editor.protect-heading-delete
  const interactions = Prec.high(keymap.of([
    {
      key: 'ArrowDown',
      run(view) {
        const block = activeBlock(view.state)
        if (!block || blockIsOpen(view.state, block) || block.to < view.state.doc.length) return false
        view.dispatch({
          changes: { from: view.state.doc.length, insert: '\n\n' },
          selection: { anchor: view.state.doc.length + 2 },
          userEvent: 'input',
          scrollIntoView: true
        })
        return true
      }
    },
    {
      key: 'ArrowRight',
      run(view) {
        const block = activeBlock(view.state)
        if (!block || blockIsOpen(view.state, block) || block.to < view.state.doc.length) return false
        view.dispatch({
          changes: { from: view.state.doc.length, insert: '\n\n' },
          selection: { anchor: view.state.doc.length + 2 },
          userEvent: 'input',
          scrollIntoView: true
        })
        return true
      }
    },
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
    interactions
  ]
}
