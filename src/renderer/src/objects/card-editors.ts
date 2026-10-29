// The editors of the object cards (ADR-0042): each is a MountedEditor inside the one shell, like the
// table editor, never a dialog. Code: a Language field and the body. Chats, terminals and traces: rows
// edited like table cells, split losslessly (simulation-segments.mjs) so an unchanged row is written
// back byte for byte and a no-op writes nothing. Speaker notes and comments: their text, as written.
// Every editor here offers Discard (the shell's, through the field's api) and commits as one undo step.
import {
  serialiseSegments,
  splitSegments,
  turnContentHints,
  TURN_ROLES,
  type AnyRow,
  type SegmentKind,
  type Segments
} from '../../../../compiler/scripts/lib/simulation-segments.mjs'
import { compiledRowCount } from '../../../../compiler/scripts/lib/simulation-reading.mjs'
import { parseMarkdownFenceOpeningLine } from '../../../../compiler/scripts/lib/03-object-token.mjs'
import {
  NOTES_PRIVACY_TEXT,
  SIMULATION_DESIGN_LABELS,
  type CardKindDeclaration
} from '../../../shared/objects/card-kinds.ts'
import type { ObjectBlock } from '../extensions/objectBlocks/detect.ts'
import {
  mountShell,
  textareaEditor,
  type MountedEditor,
  type ObjectEditorApi,
  type ShellCheatSheet
} from './shell.ts'

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function autoSize(area: HTMLTextAreaElement): void {
  area.style.height = 'auto'
  area.style.height = `${Math.max(area.scrollHeight, 22)}px`
}

function chordMatches(
  event: KeyboardEvent,
  cheatSheet: ShellCheatSheet | undefined,
  id: string,
  fallback: (event: KeyboardEvent) => boolean
): boolean {
  return cheatSheet?.matches ? cheatSheet.matches(event, id) : fallback(event)
}

// ── Code ────────────────────────────────────────────────────────────────────────────────────────

/** The fence's opening and closing lines rewritten for a new info string and/or a longer marker. */
export function rebuildFence(full: string, info: string, longerFor: string | null): string {
  const newline = full.indexOf('\n')
  const firstLine = newline >= 0 ? full.slice(0, newline) : full
  const cr = firstLine.endsWith('\r') ? '\r' : ''
  const opening = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(firstLine.replace(/\r$/, ''))
  if (!opening) return full
  let marker = opening[2]
  if (longerFor !== null) {
    let longest = 0
    for (const run of longerFor.match(new RegExp(`\\${marker[0]}{3,}`, 'g')) ?? []) longest = Math.max(longest, run.length)
    marker = marker[0].repeat(Math.max(marker.length, longest + 1))
  }
  const rest = newline >= 0 ? full.slice(newline) : ''
  // The closing line is the last line that is only a marker run of the opening character.
  const closing = new RegExp(`(\\n[ \\t]*)\\${opening[2][0]}{${opening[2].length},}([ \\t]*\\r?\\n?)$`)
  const rebuiltRest = rest.replace(closing, (_m, lead: string, tail: string) => `${lead}${marker}${tail}`)
  return `${opening[1]}${marker}${info ? info : ''}${cr}${rebuiltRest}`
}

function codeEditorFactory(block: ObjectBlock, replacementFor: (inner: string) => string): (source: string) => MountedEditor {
  const originalInfo = parseMarkdownFenceOpeningLine(block.source.split('\n')[0] ?? '')?.info ?? ''
  // One state for the card while it is open: the Markup tab and the Editor tab share the language.
  const state = { info: originalInfo, longer: false }
  return (source: string): MountedEditor => {
    const host = el('div', 'oe-code')
    const languageRow = el('label', 'oe-code-language')
    languageRow.append(el('span', '', 'Language'))
    const language = el('input', 'oe-code-language-input')
    language.value = state.info
    language.placeholder = 'plain text'
    language.spellcheck = false
    language.setAttribute('aria-label', 'Language (the fence line as written)')
    language.addEventListener('input', () => { state.info = language.value })
    languageRow.append(language)
    const area = el('textarea', 'oe-markup oe-code-body')
    area.value = source
    area.spellcheck = false
    const count = el('span', 'oe-code-count')
    const updateCount = (): void => { count.textContent = `${area.value === '' ? 0 : area.value.split('\n').length} lines` }
    updateCount()
    area.addEventListener('input', updateCount)
    // ⌥⇥ inserts a tab character; ⇥ alone moves focus like every shell editor.
    area.addEventListener('keydown', (event) => {
      if (event.key === 'Tab' && event.altKey && !event.metaKey && !event.ctrlKey) {
        event.preventDefault()
        document.execCommand('insertText', false, '\t')
      }
    })
    const longer = el('button', 'oe-code-longer', 'Use a longer fence')
    longer.type = 'button'
    longer.title = 'Rewrite this block\'s own opening and closing lines with one more marker character than any run in the text'
    longer.addEventListener('click', () => {
      state.longer = true
      longer.classList.add('on')
      longer.textContent = 'A longer fence will be written on Done'
    })
    const tools = el('div', 'oe-code-tools')
    tools.append(languageRow, count, longer)
    host.append(tools, area)
    if (/<!--[\s\S]*?-->/.test(source)) host.append(el('div', 'oe-parse-note', 'A comment inside this code is removed in the deck.'))
    return {
      element: host,
      serialise: () => area.value,
      focus: () => area.focus(),
      commitOptions: (inner: string) => {
        if (state.info === originalInfo && !state.longer) return undefined
        return { wholeBlock: rebuildFence(replacementFor(inner), state.info, state.longer ? inner : null) }
      }
    }
  }
}

// ── Rows: chat turns, terminal commands, trace turns ─────────────────────────────────────────────

type EditableRow = {
  role?: string
  duration?: string | null
  content?: string
  path?: string
  command?: string
  output?: string
  promptOnly?: string
  header?: string
  original?: AnyRow
}

const NEXT_ROLE: Readonly<Record<string, string>> = { user: 'bot', 'tool-call': 'tool-results', bot: 'user' }

function freshRow(kind: SegmentKind, after?: EditableRow): EditableRow {
  if (kind === 'turns') return { role: NEXT_ROLE[after?.role ?? ''] ?? 'user', duration: null, content: '' }
  if (kind === 'shell') return { path: after?.path ?? '', command: '', output: '', promptOnly: '' }
  return { header: 'user:', content: '' }
}

function rowFields(kind: SegmentKind, row: AnyRow): EditableRow {
  if (kind === 'turns') {
    const turn = row as Extract<AnyRow, { role: string }>
    return { role: turn.role, duration: turn.duration, content: turn.content, original: row }
  }
  if (kind === 'shell') {
    const command = row as Extract<AnyRow, { command: string }>
    return { path: command.path, command: command.command, output: command.output, original: row }
  }
  const trace = row as Extract<AnyRow, { header: string }>
  return { header: trace.header, content: trace.content, original: row }
}

/** The structure a row list reads as: the shape the re-split text must keep. */
function structureOf(kind: SegmentKind, rows: Array<Record<string, unknown>>): string[] {
  if (kind === 'turns') return rows.map((row) => String(row.role))
  if (kind === 'shell') return rows.map(() => '$')
  return rows.map((row) => String(row.header))
}

/**
 * The rows editor. `kind` picks the fields; `body` is the fence body as written. Returns a MountedEditor
 * whose serialise() is lossless and whose refusal() names a row that would read back as a different
 * structure (a content line that starts a new turn or command).
 */
export function mountRowsEditor(kind: SegmentKind, body: string, cheatSheet?: ShellCheatSheet): MountedEditor {
  const split = splitSegments(kind, body) as Segments
  let rows: EditableRow[] = split.rows.map((row) => rowFields(kind, row))
  let preamble = split.preamble.join('\n')
  /** How many more rows the deck reads in the body as written than the editor splits (normally 0). */
  const deckOffset = compiledRowCount(kind, body) - split.rows.length
  const host = el('div', `oe-rows oe-rows-${kind}`)
  host.tabIndex = -1
  let focusAfterRender: { row: number; field: string } | null = null
  // Browse (the table editor's pattern): Esc in a field selects its row; ↑↓ move the selection; ↵ or a
  // typed character edits the row again; a paste here adds labelled rows. Esc again leaves the editor.
  let browse = false
  let current = 0
  const mainField = kind === 'shell' ? 'command' : 'content'

  const serialise = (): string => serialiseSegments(
    kind,
    body,
    split,
    rows.map((row) => ({ ...row }) as Record<string, unknown> & { original?: AnyRow }),
    preamble === split.preamble.join('\n') ? split.preamble : preamble.split('\n')
  )

  const move = (index: number, delta: -1 | 1): void => {
    const target = index + delta
    if (target < 0 || target >= rows.length) return
    const next = [...rows]
    ;[next[index], next[target]] = [next[target], next[index]]
    rows = next
    focusAfterRender = { row: target, field: 'content' }
    render()
  }
  const insertAt = (index: number, row: EditableRow): void => {
    rows = [...rows.slice(0, index), row, ...rows.slice(index)]
    focusAfterRender = { row: index, field: kind === 'shell' ? 'command' : 'content' }
    render()
  }
  const remove = (index: number): void => {
    rows = rows.filter((_row, at) => at !== index)
    focusAfterRender = rows.length ? { row: Math.max(0, index - 1), field: 'content' } : null
    render()
  }

  const fieldInput = (index: number, name: string, value: string, multiline: boolean, label: string): HTMLElement => {
    const input = multiline ? el('textarea', `oe-row-${name}`) : el('input', `oe-row-${name}`)
    input.value = value
    input.spellcheck = name === 'content'
    input.dataset.row = String(index)
    input.dataset.field = name
    input.setAttribute('aria-label', label)
    if (input instanceof HTMLTextAreaElement) {
      input.rows = 1
      queueMicrotask(() => autoSize(input))
    }
    input.addEventListener('input', () => {
      rows[index] = { ...rows[index], [name as keyof EditableRow]: name === 'duration' && input.value === '' && rows[index].duration === null ? null : input.value }
      if (input instanceof HTMLTextAreaElement) autoSize(input)
    })
    input.addEventListener('keydown', (event) => onFieldKey(event as KeyboardEvent, index, name))
    input.addEventListener('focus', () => { current = index; if (browse) { browse = false; render() } })
    return input
  }

  const onFieldKey = (event: KeyboardEvent, index: number, name: string): void => {
    const up = chordMatches(event, cheatSheet, 'editor.object-row-up', (e) => e.key === 'ArrowUp' && e.ctrlKey && e.metaKey && !e.altKey && !e.shiftKey)
    const down = chordMatches(event, cheatSheet, 'editor.object-row-down', (e) => e.key === 'ArrowDown' && e.ctrlKey && e.metaKey && !e.altKey && !e.shiftKey)
    if (up || down) {
      event.preventDefault()
      event.stopPropagation()
      move(index, up ? -1 : 1)
      return
    }
    if (event.key === 'Tab' && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
      const fields = [...host.querySelectorAll<HTMLElement>('[data-field]')]
      const last = fields[fields.length - 1]
      if (last && last.dataset.row === String(index) && last.dataset.field === name) {
        event.preventDefault()
        insertAt(rows.length, freshRow(kind, rows[rows.length - 1]))
      }
    }
  }

  const rowMenu = (index: number): HTMLElement => {
    const select = el('select', 'oe-row-menu')
    select.setAttribute('aria-label', `Row ${index + 1} actions`)
    const noun = kind === 'shell' ? 'command' : 'turn'
    const choices: Array<[string, string]> = [
      ['', '⋮'],
      ['above', `Insert ${noun} above`],
      ['below', `Insert ${noun} below`],
      ['up', 'Move up'],
      ['down', 'Move down'],
      ['delete', `Delete ${noun}`]
    ]
    for (const [value, label] of choices) {
      const option = el('option', '', label)
      option.value = value
      select.append(option)
    }
    select.addEventListener('change', () => {
      const action = select.value
      select.value = ''
      if (action === 'above') insertAt(index, freshRow(kind, rows[index - 1]))
      else if (action === 'below') insertAt(index + 1, freshRow(kind, rows[index]))
      else if (action === 'up') move(index, -1)
      else if (action === 'down') move(index, 1)
      else if (action === 'delete') remove(index)
    })
    return select
  }

  const render = (): void => {
    host.replaceChildren()
    if (preamble !== '' || (kind !== 'shell' && rows.length === 0 && preamble !== '')) {
      const row = el('div', 'oe-row oe-row-preamble')
      row.append(el('span', 'oe-row-role-label', kind === 'shell' ? 'Output before the first command' : 'Text before the first turn'))
      const area = el('textarea', 'oe-row-content')
      area.value = preamble
      area.rows = 1
      area.setAttribute('aria-label', 'Text before the first row')
      queueMicrotask(() => autoSize(area))
      area.addEventListener('input', () => { preamble = area.value; autoSize(area) })
      row.append(area)
      if (kind !== 'shell' && preamble.trim()) row.append(el('div', 'oe-row-hint', 'Text before the first turn is not shown in the chat.'))
      host.append(row)
    }
    rows.forEach((row, index) => {
      const line = el('div', browse && index === current ? 'oe-row oe-row-sel' : 'oe-row')
      line.append(rowMenu(index))
      if (kind === 'turns') {
        const role = el('select', 'oe-row-role')
        role.dataset.row = String(index)
        role.dataset.field = 'role'
        role.setAttribute('aria-label', 'Role')
        for (const name of TURN_ROLES) {
          const option = el('option', '', name)
          option.value = name
          role.append(option)
        }
        role.value = String(row.role)
        role.addEventListener('change', () => { rows[index] = { ...rows[index], role: role.value }; render() })
        line.append(role)
        if (row.role === 'model-reasoning' || (row.duration !== null && row.duration !== undefined)) {
          line.append(fieldInput(index, 'duration', String(row.duration ?? ''), false, 'Duration'))
        }
        line.append(fieldInput(index, 'content', String(row.content ?? ''), true, 'Content'))
        if (row.role !== 'model-reasoning' && row.duration !== null && row.duration !== undefined) {
          const hint = el('div', 'oe-row-hint', 'Duration only applies to model-reasoning. ')
          const clear = el('button', 'oe-row-hint-action', 'Clear the duration')
          clear.type = 'button'
          clear.addEventListener('click', () => { rows[index] = { ...rows[index], duration: null }; render() })
          hint.append(clear)
          line.append(hint)
        }
        for (const found of turnContentHints(String(row.content ?? ''))) {
          const hint = el('div', 'oe-row-hint', `A line starts with "${found.word}:". TalkWeaver reads it as part of this turn. Use ${found.nearest}: `)
          const split = el('button', 'oe-row-hint-action', 'Make it a turn')
          split.type = 'button'
          split.addEventListener('click', () => {
            const parts = String(rows[index].content ?? '').split('\n')
            const head = parts.slice(0, found.line).join('\n')
            const tail = parts.slice(found.line)
            tail[0] = tail[0].replace(/^[^:]*:\s?/, '')
            rows[index] = { ...rows[index], content: head }
            insertAt(index + 1, { role: found.nearest, duration: null, content: tail.join('\n') })
          })
          hint.append(split)
          line.append(hint)
        }
      } else if (kind === 'shell') {
        line.append(fieldInput(index, 'path', String(row.path ?? ''), false, 'Prompt path'))
        line.append(el('span', 'oe-row-prompt', '$'))
        line.append(fieldInput(index, 'command', String(row.command ?? ''), false, 'Command'))
        line.append(fieldInput(index, 'output', String(row.output ?? ''), true, 'Output, as written'))
      } else {
        line.append(fieldInput(index, 'header', String(row.header ?? ''), false, 'Header line, as written'))
        line.append(fieldInput(index, 'content', String(row.content ?? ''), true, 'Content'))
      }
      host.append(line)
    })
    const add = el('div', 'addbar')
    const button = el('button', '', kind === 'shell' ? '+ Add command' : '+ Add turn')
    button.type = 'button'
    button.addEventListener('click', () => insertAt(rows.length, freshRow(kind, rows[rows.length - 1])))
    add.append(button)
    host.append(add)
    if (focusAfterRender) {
      const { row, field } = focusAfterRender
      focusAfterRender = null
      queueMicrotask(() => {
        const target = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-row="${row}"][data-field="${field}"]`)
        target?.focus()
        // Back from browsing (or after a paste) the caret goes after the text, where the typing continues.
        if (target && typeof target.value === 'string') target.setSelectionRange?.(target.value.length, target.value.length)
      })
    }
  }
  const enterBrowse = (): boolean => {
    if (browse || !rows.length) return false
    const at = Number((document.activeElement as HTMLElement | null)?.dataset?.row)
    if (Number.isInteger(at) && at >= 0 && at < rows.length) current = at
    browse = true
    render()
    host.focus()
    return true
  }
  const editCurrent = (): void => {
    browse = false
    focusAfterRender = rows.length ? { row: Math.min(current, rows.length - 1), field: mainField } : null
    render()
  }
  host.addEventListener('keydown', (event) => {
    if (!browse || event.target !== host) return
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey
    if (plain && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault()
      current = Math.max(0, Math.min(rows.length - 1, current + (event.key === 'ArrowUp' ? -1 : 1)))
      render()
      host.focus()
    } else if (plain && event.key === 'Enter') {
      event.preventDefault()
      editCurrent()
    } else if (plain && event.key.length === 1) {
      event.preventDefault()
      const field = rows[current]?.[mainField as keyof EditableRow]
      rows[current] = { ...rows[current], [mainField]: `${typeof field === 'string' ? field : ''}${event.key}` }
      editCurrent()
    }
  })
  host.addEventListener('paste', (event) => {
    if (!browse || event.target !== host) return
    const text = (event as ClipboardEvent).clipboardData?.getData('text/plain') ?? ''
    if (!text) return
    event.preventDefault()
    pasteInBrowse(text)
  })
  /**
   * A paste while browsing: text made only of rows (labelled turns, prompt lines or trace headers, with
   * nothing but blank lines before the first) becomes those rows after the selected one, written as
   * pasted; anything else goes into the selected row's text exactly as pasted (before the first row
   * when there is none), so plain text is never read as turns it does not name.
   */
  const pasteInBrowse = (raw: string): void => {
    const text = raw.replace(/\r\n?/g, '\n')
    // The line ending a copied block usually ends with is not a blank line of the chat.
    const pasted = splitSegments(kind, text.replace(/\n+$/, '')) as Segments
    if (pasted.rows.length && pasted.preamble.every((line) => !line.trim())) {
      // Written byte for byte only when the body takes the lines as they are (no indent of its own, LF);
      // otherwise the rows are written in the body's own indent and line ending, with the same words.
      const asWritten = !body.includes('\r\n') && (kind !== 'turns' || (pasted.indent ?? 0) === (split.indent ?? 0))
      const added = pasted.rows.map((row) => {
        const fields = rowFields(kind, row)
        return asWritten ? fields : { ...fields, original: undefined }
      })
      const at = rows.length ? current + 1 : 0
      rows = [...rows.slice(0, at), ...added, ...rows.slice(at)]
      current = at + added.length - 1
      render()
      host.focus()
      return
    }
    if (!rows.length) {
      preamble = preamble ? `${preamble}\n${text}` : text
      browse = false
      render()
      return
    }
    const field = kind === 'shell' ? 'output' : 'content'
    const before = String(rows[current][field as keyof EditableRow] ?? '')
    rows[current] = { ...rows[current], [field]: before ? `${before}\n${text}` : text }
    browse = false
    focusAfterRender = { row: current, field }
    render()
  }
  render()

  return {
    element: host,
    serialise,
    focus: () => (host.querySelector<HTMLElement>('[data-field]') ?? host).focus(),
    onEscape: enterBrowse,
    refusal: (source: string) => {
      const expected = structureOf(kind, rows as Array<Record<string, unknown>>)
      const reread = splitSegments(kind, source) as Segments
      const actual = structureOf(kind, reread.rows as unknown as Array<Record<string, unknown>>)
      const noun = kind === 'shell' ? 'command' : 'turn'
      if (expected.length === actual.length && expected.every((value, index) => value === actual[index])) {
        // The deck's own reading must find the rows the editor holds: added and removed rows are fine,
        // a row it would split or merge is not. A difference the body already had (a line ending only
        // the deck reads as a break) is kept as it was, never a reason to refuse every edit.
        const deck = compiledRowCount(kind, source)
        const wanted = rows.length + deckOffset
        if (deck === wanted) return null
        return `the slide would show ${deck} ${noun}${deck === 1 ? '' : 's'} where the editor has ${wanted}. Check the ${noun} lines, or edit in the Markup tab`
      }
      const at = expected.findIndex((value, index) => value !== actual[index])
      const row = at < 0 ? expected.length : at
      return kind === 'shell'
        ? `a line in command ${row + 1} looks like a prompt ($); TalkWeaver would read it as a new command. Start it with \\ to keep it as output`
        : `a line in ${noun} ${row + 1} would read as a new ${noun}. Add it as a ${noun}, or put a word before the colon`
    }
  }
}

// ── Mount ────────────────────────────────────────────────────────────────────────────────────────

const ROW_KIND: Readonly<Record<string, SegmentKind>> = { turns: 'turns', 'shell-session': 'shell', 'trace-rows': 'trace' }

export function mountCardEditor(
  block: ObjectBlock,
  card: CardKindDeclaration,
  inner: string,
  markup: MountedEditor,
  api: ObjectEditorApi,
  cheatSheet: ShellCheatSheet | undefined,
  replacementFor: (inner: string) => string
): HTMLElement {
  if (card.editor === 'code') {
    const factory = codeEditorFactory(block, replacementFor)
    return mountShell({
      kind: block.simNote ? `${card.label} · ${block.simNote === 'ignored' ? 'ignored by this chat slide' : 'shown as code on this slide'}` : card.label,
      editor: factory(inner),
      markup,
      parseEditor: factory,
      foot: '⌥⇥ tab character · esc leave · ⌘↵ done',
      api,
      cheatSheet
    })
  }
  const rowKind = ROW_KIND[card.editor]
  if (rowKind) {
    const design = block.design ? ` · ${SIMULATION_DESIGN_LABELS[block.design] ?? block.design}` : ''
    const noun = rowKind === 'shell' ? 'command' : 'turn'
    // Rows only when they are what the slide shows: a body the deck reads as a different number of rows
    // (a line ending only the deck breaks on) opens on its lines as written, never as rows that mislead.
    const asRows = (source: string): boolean =>
      compiledRowCount(rowKind, source) === (splitSegments(rowKind, source) as Segments).rows.length
    if (!asRows(inner)) {
      return mountShell({
        kind: `${card.label}${design} · lines as written`,
        editor: textareaEditor(inner),
        foot: `the slide reads these lines as different ${noun}s than rows would show · esc leave · ⌘↵ done`,
        api,
        cheatSheet
      })
    }
    return mountShell({
      kind: `${card.label}${design}`,
      editor: mountRowsEditor(rowKind, inner, cheatSheet),
      markup,
      parseEditor: (source) => (asRows(source) ? mountRowsEditor(rowKind, source, cheatSheet) : null),
      foot: `⇥ next field · ⇥ past the last adds a ${noun} · ⌃⌘↑↓ move ${noun} · esc select rows, paste adds ${noun}s · esc again leave · ⌘↵ done`,
      api,
      cheatSheet
    })
  }
  if (card.editor === 'notes') {
    const editor = textareaEditor(inner, 'oe-markup oe-notes-body')
    editor.element.setAttribute('aria-label', 'Speaker notes, presenter only')
    editor.element.title = NOTES_PRIVACY_TEXT
    return mountShell({
      kind: block.deckNotes ? `${card.label} · whole talk · Presenter only` : `${card.label} · Presenter only`,
      editor,
      foot: '↵ newline · esc leave · ⌘↵ done',
      api,
      cheatSheet
    })
  }
  if (card.editor === 'source') {
    return mountShell({
      kind: `${card.label} · source`,
      editor: textareaEditor(inner, 'oe-markup oe-embed-source'),
      foot: 'the lines as written · esc leave · ⌘↵ done',
      api,
      cheatSheet
    })
  }
  return mountShell({
    kind: block.comment ? `${card.label} · ${block.comment.label.replace(/^Comment · /, '')}` : card.label,
    editor: textareaEditor(inner, 'oe-markup oe-comment-source'),
    foot: 'the comment stays one block from <!-- to --> · esc leave · ⌘↵ done',
    api,
    cheatSheet
  })
}
