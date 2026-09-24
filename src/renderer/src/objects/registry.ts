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

/** Preserve all original bytes on a no-op and otherwise preserve the final-newline shape. */
export function objectEditorReplacement(block: ObjectBlock, inner: string): string {
  if (inner === innerSource(block)) return block.source
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

export function planObjectEditorCommit(
  block: ObjectBlock,
  currentDoc: string,
  inner: string
): ObjectEditorCommitPlan {
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
