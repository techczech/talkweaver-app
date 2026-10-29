import {
  parseTable,
  serialiseTable,
} from '../../../shared/objects/object-markup.ts'
import {
  objectLayoutEntryForBlockKind,
  type ObjectDeclaration,
} from '../../../shared/layout-registry/entries.ts'
import {
  parseTriggerTable,
  serialiseTriggerTable,
} from '../../../shared/objects/trigger-table.ts'
import {
  detectObjectBlocks,
  objectBlockEditableSource,
  type ObjectBlock
} from '../extensions/objectBlocks/detect.ts'
import { mountChartEditor } from './chart-editor.ts'
import { chartShapeForBlock } from './chart-model.ts'
import { mountMarkmapEditor } from './markmap-editor.ts'
import { mountMermaidEditor } from './mermaid-editor.ts'
import {
  mountShell,
  textareaEditor,
  type MountedEditor,
  type ObjectEditorApi,
  type ShellCheatSheet,
} from './shell.ts'
import { mountSvgEditor } from './svg-editor.ts'
import { mountTableEditor } from './table-editor.ts'
import {
  isMarkdownFenceClosingLine,
  parseMarkdownFenceOpeningLine
} from '../../../../compiler/scripts/lib/03-object-token.mjs'
import { closedHtmlComments } from '../../../../compiler/scripts/lib/outline-regions.mjs'
import { cardKind } from '../../../shared/objects/card-kinds.ts'
import { notesBodyRefusal } from '../../../shared/objects/notes-body.ts'
import { restoreLineEndings } from '../../../shared/objects/line-endings.ts'
import { mountCardEditor } from './card-editors.ts'
import { compilerErrorRefusal, type AssetFact } from '../../../shared/objects/compiler-error-check.ts'
import { cardStatusRefs } from '../extensions/objectBlocks/status.ts'
import type { ObjectEditorCommitOptions } from './shell.ts'

const FENCE_CARD_KINDS = new Set(['code', 'chat', 'terminal', 'trace'])

/**
 * The refusal a card kind adds before the shared re-detection check (ADR-0042; notes design §4.3).
 * Each names, in words, the line that would break the object; none is auto-fixed.
 */
export function cardBodyRefusal(block: ObjectBlock, inner: string): string | null {
  const lines = inner.split('\n').map((line) => line.replace(/\r$/, ''))
  if (FENCE_CARD_KINDS.has(block.kind)) {
    const opening = parseMarkdownFenceOpeningLine(block.source.split('\n')[0] ?? '')
    if (opening && lines.some((line) => isMarkdownFenceClosingLine(line, opening))) {
      return `this text contains a line of ${opening.marker} that would end the block. Use a longer fence`
    }
    return null
  }
  if (block.kind === 'notes') return notesBodyRefusal(inner)
  if (block.kind === 'comment') {
    const found = closedHtmlComments(inner)
    if (found.length !== 1 || found[0].from !== 0 || found[0].to !== inner.length) {
      return 'the comment must stay one block from <!-- to -->'
    }
  }
  return null
}

/** A whole-block replacement (a code card's new language or longer fence): stale-checked and re-detected. */
function planWholeBlockCommit(block: ObjectBlock, currentDoc: string, wholeBlock: string): ObjectEditorCommitPlan {
  if (currentDoc.slice(block.from, block.to) !== block.source) {
    return { ok: false, reason: 'the editor shell was stale and no longer matched the active document' }
  }
  const nextDoc = `${currentDoc.slice(0, block.from)}${wholeBlock}${currentDoc.slice(block.to)}`
  const parsed = detectObjectBlocks(nextDoc).find((candidate) => candidate.from === block.from)
  if (!parsed || parsed.source !== wholeBlock || typeof parsed.bodyFrom !== 'number') {
    return { ok: false, reason: 'the new fence lines could not be read back as one closed block without changing its bytes' }
  }
  return { ok: true, change: { from: block.from, to: block.to, insert: wholeBlock } }
}

export function innerSource(block: ObjectBlock): string {
  return objectBlockEditableSource(block)
}

export function serialiseBlock(block: ObjectBlock, inner: string): string {
  if (
    typeof block.bodyFrom === 'number'
    && typeof block.bodyTo === 'number'
  ) {
    const localFrom = block.bodyFrom - block.from
    const localTo = block.bodyTo - block.from
    const suffix = block.source.slice(localTo)
    // Adjacent opening/closing markers have no body separator to preserve yet.
    const separator = localFrom === localTo && inner && !inner.endsWith('\n') && !/^\r?\n/.test(suffix)
      ? block.source.includes('\r\n') ? '\r\n' : '\n'
      : ''
    return `${block.source.slice(0, localFrom)}${inner}${separator}${suffix}`
  }
  if (
    block.kind === 'gfm-table'
    || !/^\s*(`{3,}|~{3,})/.test(block.source)
  ) {
    return inner
  }
  const fallbackInfo = block.kind === 'mermaid' ? 'mermaid' : 'svg'
  const info = /^```([^\r\n]*)/.exec(block.source)?.[1] || fallbackInfo
  return `\`\`\`${info}\n${inner.replace(/\r?\n/g, '\n').replace(/\n+$/, '')}\n\`\`\``
}

// Line endings of an edited card body: src/shared/objects/line-endings.ts (line-matched, review R1).
export { restoreLineEndings }

export const LINE_ENDINGS_REFUSAL = 'This block mixes line endings and the change is too large to keep each untouched line’s ending exactly, so nothing was written. Make the change in smaller steps.'

/** Preserve all original bytes on a no-op and otherwise preserve the final-newline shape. */
export function objectEditorReplacement(block: ObjectBlock, inner: string): string {
  if (inner === innerSource(block)) return block.source
  if (cardKind(block.kind)) {
    // A card editor's text: a row editor hands over exact bytes (its unchanged rows carry their own
    // endings, so any CR in it is deliberate); a text field hands over LF only, restored line by line.
    const exact = inner.includes('\r') ? inner : restoreLineEndings(innerSource(block), inner)
    // Not provable within the bounds (planObjectEditorChange refuses first): the card stays as it is.
    if (exact === null) return block.source
    if (typeof block.bodyFrom === 'number' && typeof block.bodyTo === 'number') return serialiseBlock(block, exact)
    const trailing = block.source.endsWith('\r\n') ? '\r\n' : block.source.endsWith('\n') ? '\n' : ''
    return `${exact}${trailing}`
  }
  const lineEnding = block.source.includes('\r\n') ? '\r\n' : '\n'
  if (
    typeof block.bodyFrom === 'number'
    && typeof block.bodyTo === 'number'
  ) {
    return serialiseBlock(block, inner.replace(/\r?\n/g, lineEnding))
  }
  const serialised = serialiseBlock(block, inner).replace(/\r?\n/g, lineEnding)
  const trailing = block.source.endsWith('\r\n')
    ? '\r\n'
    : block.source.endsWith('\n')
      ? '\n'
      : ''
  return `${serialised}${trailing}`
}

export function objectEditorCommitRefusal(
  block: ObjectBlock,
  currentDoc: string,
  replacement: string,
  inner: string
): string | null {
  if (innerSource(block).trim() !== '' && inner.trim() === '') {
    return 'replacement inner source was empty while the original inner source was not'
  }
  if (currentDoc.slice(block.from, block.to) !== block.source) {
    return 'the editor shell was stale and no longer matched the active document'
  }
  const nextDoc = `${currentDoc.slice(0, block.from)}${replacement}${currentDoc.slice(block.to)}`
  const parsed = detectObjectBlocks(nextDoc).find((candidate) => candidate.from === block.from)
  if (
    !parsed
    || parsed.kind !== block.kind
    || parsed.source !== replacement
  ) {
    return `replacement could not be parsed back as ${block.kind} without changing its bytes`
  }
  return null
}

export type ObjectEditorCommitPlan =
  | { ok: true; change: { from: number; to: number; insert: string } }
  | { ok: false; reason: string }

/** What the editor knows beyond the text: main's answers about the files cards name (object status). */
export type ObjectCommitFacts = { statusOf?: (ref: string) => string | undefined }

/** The files the cards in `doc` name, with the state main answered for each (unanswered ones left out). */
function assetFacts(doc: string, statusOf: (ref: string) => string | undefined): AssetFact[] {
  const facts: AssetFact[] = []
  for (const block of detectObjectBlocks(doc)) {
    for (const ref of cardStatusRefs(block)) {
      const state = statusOf(ref)
      if (state) facts.push({ ref, state })
    }
  }
  return facts
}

/**
 * The commit plan for an object editor: the shape checks below, then the compiler-error check (a change
 * that adds a compiler error the outline did not have is not written; errors already there never block).
 */
export function planObjectEditorCommit(
  block: ObjectBlock,
  currentDoc: string,
  inner: string,
  options?: ObjectEditorCommitOptions,
  facts?: ObjectCommitFacts
): ObjectEditorCommitPlan {
  const plan = planObjectEditorChange(block, currentDoc, inner, options)
  if (!plan.ok || plan.change.insert === currentDoc.slice(plan.change.from, plan.change.to)) return plan
  const nextDoc = `${currentDoc.slice(0, plan.change.from)}${plan.change.insert}${currentDoc.slice(plan.change.to)}`
  const statusOf = facts?.statusOf
  const refusal = compilerErrorRefusal(
    currentDoc,
    nextDoc,
    statusOf ? assetFacts(currentDoc, statusOf) : [],
    statusOf ? assetFacts(nextDoc, statusOf) : []
  )
  return refusal ? { ok: false, reason: refusal } : plan
}

function planObjectEditorChange(
  block: ObjectBlock,
  currentDoc: string,
  inner: string,
  options?: ObjectEditorCommitOptions
): ObjectEditorCommitPlan {
  if (options?.wholeBlock !== undefined && options.wholeBlock !== block.source) {
    return planWholeBlockCommit(block, currentDoc, options.wholeBlock)
  }
  if (inner !== innerSource(block)) {
    const cardRefusal = cardBodyRefusal(block, inner)
    if (cardRefusal) return { ok: false, reason: cardRefusal }
  }
  if (cardKind(block.kind) && !inner.includes('\r') && inner !== innerSource(block)
    && restoreLineEndings(innerSource(block), inner) === null) {
    return { ok: false, reason: LINE_ENDINGS_REFUSAL }
  }
  const replacement = objectEditorReplacement(block, inner)
  const refusal = objectEditorCommitRefusal(block, currentDoc, replacement, inner)
  if (refusal) return { ok: false, reason: refusal }
  if (
    typeof block.bodyFrom === 'number'
    && typeof block.bodyTo === 'number'
  ) {
    const prefixLength = block.bodyFrom - block.from
    const suffixLength = block.to - block.bodyTo
    return {
      ok: true,
      change: {
        from: block.bodyFrom,
        to: block.bodyTo,
        insert: replacement.slice(prefixLength, replacement.length - suffixLength)
      }
    }
  }
  return {
    ok: true,
    change: {
      from: block.from,
      to: Math.min(block.to, currentDoc.length),
      insert: replacement
    }
  }
}

function wrapTriggerTableSerialise(
  grid: MountedEditor,
  original: string
): MountedEditor {
  const originalGrid = grid.serialise()
  return {
    element: grid.element,
    focus: () => grid.focus(),
    onEscape: grid.onEscape ? () => grid.onEscape?.() === true : undefined,
    destroy: grid.destroy ? () => grid.destroy?.() : undefined,
    serialise: () => {
      const gridSource = grid.serialise()
      if (gridSource === originalGrid) return original
      const model = parseTable(gridSource)
      return model ? serialiseTriggerTable(model) : gridSource
    },
  }
}

function triggerGrid(source: string): MountedEditor | null {
  const model = parseTriggerTable(source)
  if (!model) return null
  const grid = mountTableEditor(serialiseTable(model))
  return grid ? wrapTriggerTableSerialise(grid, source) : null
}

type ObjectEditorMount = (
  block: ObjectBlock,
  declaration: ObjectDeclaration,
  inner: string,
  markup: MountedEditor,
  api: ObjectEditorApi,
  cheatSheet?: ShellCheatSheet
) => HTMLElement | null

const SOURCE_EDITORS: Record<string, {
  kind: string
  mount: (source: string) => MountedEditor
  foot: string
}> = {
  mermaid: {
    kind: 'Mermaid',
    mount: mountMermaidEditor,
    foot: 'live preview · ⌘↵ done',
  },
  svg: {
    kind: 'SVG',
    mount: mountSvgEditor,
    foot: 'live preview · ⌘↵ done',
  },
}

const OBJECT_EDITORS: Record<ObjectDeclaration['editor'], ObjectEditorMount> = {
  grid: (block, _declaration, inner, markup, api, cheatSheet) => {
    const isTriggerTable = block.kind === 'trigger-table'
    const parseEditor = isTriggerTable ? triggerGrid : mountTableEditor
    const grid = parseEditor(inner)
    if (!grid) {
      return mountShell({
        kind: 'Table',
        editor: markup,
        foot: isTriggerTable
          ? 'nested-list form · ⌘↵ done'
          : 'pipe-table markup · ⌘↵ done',
        api,
        cheatSheet,
      })
    }
    return mountShell({
      kind: 'Table',
      editor: grid,
      markup,
      parseEditor,
      foot: isTriggerTable
        ? 'trigger form — columns are top-level items · ⌘↵ done'
        : '↵ newline in cell · ⇥ next cell · esc browse · ⌘↵ done',
      api,
      cheatSheet,
    })
  },
  outline: (block, declaration, inner, markup, api, cheatSheet) => {
    if (declaration.widget === 'chart') {
      const shape = chartShapeForBlock(block)
      if (!shape) {
        return mountShell({
          kind: 'Chart',
          editor: markup,
          foot: 'markup only — resolve the chart trigger before using the visual editor · ⌘↵ done',
          api,
          cheatSheet,
        })
      }
      const parseEditor = (source: string): MountedEditor | null =>
        mountChartEditor(source, shape)
      const editor = parseEditor(inner)
      if (!editor) {
        return mountShell({
          kind: 'Chart',
          editor: markup,
          foot: 'markup only — add a numeric value to each list item · ⌘↵ done',
          api,
          cheatSheet,
        })
      }
      return mountShell({
        kind: 'Chart',
        editor,
        markup,
        parseEditor,
        foot: '↵ sibling · ⇥ indent · ⇧⇥ outdent · ⌥↑↓ move subtree · ⌘↵ done',
        api,
        cheatSheet,
      })
    }
    return mountShell({
      kind: 'Mind map',
      editor: mountMarkmapEditor(inner),
      markup,
      parseEditor: mountMarkmapEditor,
      foot: '↵ sibling · ⇥ indent · ⇧⇥ outdent · ⌥↑↓ move subtree · ⌘↵ done',
      api,
      cheatSheet,
    })
  },
  source: (_block, declaration, inner, markup, api, cheatSheet) => {
    const sourceEditor = SOURCE_EDITORS[declaration.widget]
    if (!sourceEditor) return null
    return mountShell({
      kind: sourceEditor.kind,
      editor: sourceEditor.mount(inner),
      markup,
      parseEditor: sourceEditor.mount,
      foot: sourceEditor.foot,
      api,
      cheatSheet,
    })
  },
}

function mountMarkupFallback(
  block: ObjectBlock,
  markup: MountedEditor,
  api: ObjectEditorApi,
  cheatSheet: ShellCheatSheet | undefined,
  reason: string
): HTMLElement {
  console.error(`${reason} Showing raw markup editor instead.`)
  return mountShell({
    kind: block.kind,
    editor: markup,
    foot: 'markup only · ⌘↵ done',
    api,
    cheatSheet,
  })
}

export function mountObjectEditor(
  block: ObjectBlock,
  api: ObjectEditorApi,
  cheatSheet?: ShellCheatSheet
): HTMLElement {
  const inner = innerSource(block)
  const markup = textareaEditor(inner)
  const card = cardKind(block.kind)
  if (card) return mountCardEditor(block, card, inner, markup, api, cheatSheet, (next) => objectEditorReplacement(block, next))
  const declaration = objectLayoutEntryForBlockKind(block.kind)?.object
  if (!declaration) {
    return mountMarkupFallback(
      block,
      markup,
      api,
      cheatSheet,
      `No registry-declared editor for object block ${block.kind}.`
    )
  }
  const mount = OBJECT_EDITORS[declaration.editor]
  if (!mount) {
    return mountMarkupFallback(
      block,
      markup,
      api,
      cheatSheet,
      `No object editor implementation for registry editor ${declaration.editor} on ${block.kind}.`
    )
  }
  return mount(block, declaration, inner, markup, api, cheatSheet)
    ?? mountMarkupFallback(
      block,
      markup,
      api,
      cheatSheet,
      `No object editor implementation for registry widget ${declaration.widget} on ${block.kind}.`
    )
}
