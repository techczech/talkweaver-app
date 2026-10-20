// The pre-work and post-work strips under the Metadata table (work-files ticket 08; mockup shots 1-*),
// and the file picker the table's Pre-work and Post-work rows use.
//
// What each strip says comes from the pure model (src/shared/work-strips.ts); this file only draws it
// and carries out its one action. The data it draws from (work files, Runs, now) arrives from the
// editor as a state effect; a change of the document (the talk's `prework:` / `postwork:`) redraws.
// Attaching goes through the same byte-preserving frontmatter write as every other metadata row
// (`setKey` from frontmatterTable.ts), so only the one key changes.
//
// A strip's menu (Attach, Open run) belongs to its editor: each EditorView has at most one open, and it
// closes on an outside mousedown, Escape, a change of the document (another talk, an attach, typing),
// new strip data, and when the view is destroyed (workStripMenuPlugin). No menu state is module-wide.
import { Facet, StateEffect, StateField, type EditorState } from '@codemirror/state'
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view'
import {
  STRIP_MARK_TEXT, workStrips,
  type StripFile, type StripMenuRow, type StripRun, type StripRunRef, type WorkStrip, type WorkStrips
} from '../../../shared/work-strips.ts'
import { talkWorkFile, workFileValue } from '../../../shared/work-file-name.ts'

/** What the editor loads for the open talk. `null` while unknown, or when the work files could not be read. */
export interface WorkStripsData {
  talkSlug: string
  /** The open talk's vault, when known: only its Runs count, and Open run opens its Run. */
  vaultId?: string
  files: StripFile[]
  /** null when the Runs could not be read. */
  runs: StripRun[] | null
  /** Epoch milliseconds when the data was read. */
  now: number
}

export const setWorkStripsData = StateEffect.define<WorkStripsData | null>()
export const workStripsField = StateField.define<WorkStripsData | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setWorkStripsData)) return effect.value
    return value
  }
})

/** What a strip's buttons do beyond writing the file's name into the talk. */
export interface WorkStripHandlers {
  planRun(): void
  openRun(ref: StripRunRef): void
}
export const workStripHandlersFacet = Facet.define<WorkStripHandlers, WorkStripHandlers | null>({
  combine: (values) => values[0] ?? null
})

/** The frontmatter keys the two phases write. */
export const WORK_KEY: Record<'pre' | 'post', 'prework' | 'postwork'> = { pre: 'prework', post: 'postwork' }
export const isWorkKey = (key: string): boolean => key === 'prework' || key === 'postwork'

/** A strip's inputs for one document: the loaded data and the document's own pairs. Null when nothing loaded. */
export function stripsFor(state: Pick<EditorState, 'field'>, pairs: ReadonlyArray<{ key: string; value: string }>): { strips: WorkStrips; files: StripFile[] } | null {
  const data = state.field(workStripsField, false)
  if (!data) return null
  const value = (key: string): string | undefined => pairs.find((pair) => pair.key === key)?.value
  return {
    files: data.files,
    strips: workStrips({ talkSlug: data.talkSlug, vaultId: data.vaultId, metadata: { prework: value('prework'), postwork: value('postwork') }, files: data.files, runs: data.runs, now: new Date(data.now) })
  }
}

// ── drawing ───────────────────────────────────────────────────────────────────

type SetKey = (key: string, value: string | null, aliases?: string[], raw?: boolean) => void

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

// Lucide paths (24-unit grid), the icons the mockup draws.
const ICONS: Record<string, string[]> = {
  'list-checks': ['m3 17 2 2 4-4', 'm3 7 2 2 4-4', 'M13 6h8', 'M13 12h8', 'M13 18h8'],
  message: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
  paperclip: ['m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48'],
  'calendar-plus': ['M8 2v4', 'M16 2v4', 'M21 13V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8', 'M3 10h18', 'M16 19h6', 'M19 16v6'],
  'arrow-up-right': ['M7 7h10v10', 'M7 17 17 7'],
  'chevron-down': ['m6 9 6 6 6-6']
}
function icon(name: string): SVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '14'); svg.setAttribute('height', '14')
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true')
  svg.classList.add('cm-fm-strip-icon')
  for (const d of ICONS[name] ?? []) {
    const path = document.createElementNS(ns, 'path')
    path.setAttribute('d', d)
    svg.appendChild(path)
  }
  return svg
}

interface MenuItem { label: string; detail?: string; mark?: string; disabled?: boolean; run?: () => void }

/** The one open strip menu of an editor, and how to close it. */
class StripMenus {
  private closeOpen: (() => void) | null = null

  close(): void { this.closeOpen?.() }

  /** A small menu under a button, outside the table (the table clips its own overflow). */
  open(anchor: HTMLElement, items: MenuItem[], kind: string): void {
    this.close()
    const doc = anchor.ownerDocument
    const menu = el('div', 'cm-fm-strip-menu')
    menu.dataset.stripMenu = kind
    menu.setAttribute('role', 'menu')
    for (const item of items) {
      const row = el('button', 'cm-fm-strip-menu-item')
      row.type = 'button'
      row.setAttribute('role', 'menuitem')
      row.disabled = item.disabled === true
      row.appendChild(el('span', 'cm-fm-strip-menu-name', item.label))
      if (item.detail) row.appendChild(el('em', 'cm-fm-strip-menu-detail', item.detail))
      if (item.mark) row.appendChild(el('span', 'cm-fm-strip-mark', item.mark))
      row.addEventListener('mousedown', (event) => { event.preventDefault(); event.stopPropagation() })
      row.addEventListener('click', () => { close(); item.run?.() })
      menu.appendChild(row)
    }
    const rect = anchor.getBoundingClientRect()
    const win = doc.defaultView ?? window
    menu.style.top = `${Math.round(rect.bottom + 4)}px`
    menu.style.right = `${Math.max(8, Math.round(win.innerWidth - rect.right))}px`
    const onDown = (event: MouseEvent): void => { if (!menu.contains(event.target as Node) && event.target !== anchor) close() }
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') close() }
    const close = (): void => {
      doc.removeEventListener('mousedown', onDown, true)
      doc.removeEventListener('keydown', onKey, true)
      menu.remove()
      if (this.closeOpen === close) this.closeOpen = null
    }
    this.closeOpen = close
    doc.addEventListener('mousedown', onDown, true)
    doc.addEventListener('keydown', onKey, true)
    doc.body.appendChild(menu)
    menu.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus()
  }
}

const stripMenus = new WeakMap<EditorView, StripMenus>()
function menusOf(view: EditorView): StripMenus {
  let menus = stripMenus.get(view)
  if (!menus) { menus = new StripMenus(); stripMenus.set(view, menus) }
  return menus
}

/** Closes the editor's open strip menu when the document or the strip data changes, and with the view. */
// No parameter property: the node tests load this file with type stripping only.
export const workStripMenuPlugin = ViewPlugin.fromClass(class {
  readonly view: EditorView
  constructor(view: EditorView) { this.view = view }
  update(update: ViewUpdate): void {
    if (update.docChanged || update.startState.field(workStripsField, false) !== update.state.field(workStripsField, false)) {
      stripMenus.get(update.view)?.close()
    }
  }
  destroy(): void {
    stripMenus.get(this.view)?.close()
    stripMenus.delete(this.view)
  }
})

/** Why a file cannot be attached: a Run names its work files by id. */
const NO_ID = 'needs an id before a Run can send it'

function fileItems(files: StripFile[], phase: 'pre' | 'post', setKey: SetKey): MenuItem[] {
  if (files.length === 0) return [{ label: 'No work files yet', detail: 'Make one in Tools › Work files', disabled: true }]
  // A file with no id is shown, disabled, with the reason: a Run names its work files by id (runs.ts).
  return files.map((file) => {
    const value = workFileValue(file)
    const steps = `${file.steps} ${file.steps === 1 ? 'step' : 'steps'}`
    return value
      ? { label: file.title, detail: steps, run: () => setKey(WORK_KEY[phase], value) }
      : { label: file.title, detail: NO_ID, disabled: true }
  })
}

function rowItems(rows: StripMenuRow[], handlers: WorkStripHandlers | null): MenuItem[] {
  return rows.map((row) => ({
    label: row.name, detail: row.detail, ...(row.mark ? { mark: STRIP_MARK_TEXT[row.mark] } : {}),
    run: () => handlers?.openRun(row.ref)
  }))
}

function drawStrip(view: EditorView, strip: WorkStrip, files: StripFile[], setKey: SetKey, handlers: WorkStripHandlers | null): HTMLElement {
  const root = el('div', `cm-fm-strip is-${strip.tone}`)
  root.dataset.workStrip = strip.phase
  root.dataset.stripState = strip.state
  root.appendChild(icon(strip.phase === 'pre' ? 'list-checks' : 'message'))
  const parts = el('span', 'cm-fm-strip-text')
  parts.appendChild(el('b', undefined, strip.lead))
  const addPart = (text: string, className?: string): void => {
    if (!text) return
    parts.appendChild(el('span', 'cm-fm-strip-dot', '·'))
    parts.appendChild(el('span', className, text))
  }
  addPart(strip.fileName, 'cm-fm-strip-file')
  addPart(strip.steps)
  addPart(strip.status, 'cm-fm-strip-status')
  if (strip.mark) addPart(STRIP_MARK_TEXT[strip.mark], 'cm-fm-strip-mark')
  root.appendChild(parts)
  root.appendChild(el('span', 'cm-fm-strip-sp'))

  const action = strip.action
  const button = el('button', 'cm-fm-strip-btn')
  button.type = 'button'
  button.dataset.stripAction = action.kind
  button.appendChild(icon(action.kind === 'attach' ? 'paperclip' : action.kind === 'plan-run' ? 'calendar-plus' : 'arrow-up-right'))
  button.appendChild(el('span', undefined, action.label))
  if (action.kind === 'open-run-menu') button.appendChild(icon('chevron-down'))
  // The editor keeps focus: a mousedown on the strip must not move the caret into the document.
  button.addEventListener('mousedown', (event) => event.preventDefault())
  button.addEventListener('click', () => {
    if (action.kind === 'attach') menusOf(view).open(button, fileItems(files, strip.phase, setKey), `attach-${strip.phase}`)
    else if (action.kind === 'plan-run') handlers?.planRun()
    else if (action.kind === 'open-run') handlers?.openRun(action.ref)
    else menusOf(view).open(button, rowItems(action.rows, handlers), `runs-${strip.phase}`)
  })
  root.appendChild(button)
  return root
}

/**
 * The "Attach a pre-work file" and "Attach a post-work file" commands (work-files ticket 30): they press the
 * strip's own button, so the menu, the write and the refusals are the strip's. Returns why nothing opened, or null.
 */
export function pressAttachOnStrip(root: ParentNode, phase: 'pre' | 'post'): string | null {
  const word = phase === 'pre' ? 'pre-work' : 'post-work'
  const strip = root.querySelector<HTMLElement>(`[data-work-strip="${phase}"]`)
  if (!strip) return `Open the talk's Metadata table to attach a ${word} file.`
  const button = strip.querySelector<HTMLButtonElement>('[data-strip-action="attach"]')
  if (!button) return `This talk already names a ${word} file. Change it in the ${phase === 'pre' ? 'Pre-work' : 'Post-work'} row of the Metadata table.`
  button.click()
  return null
}

/** Both strips, as the table draws them under its rows. */
export function drawWorkStrips(view: EditorView, strips: WorkStrips, files: StripFile[], setKey: SetKey, handlers: WorkStripHandlers | null): HTMLElement {
  const wrap = el('div', 'cm-fm-strips')
  wrap.dataset.workStrips = 'true'
  wrap.appendChild(drawStrip(view, strips.pre, files, setKey, handlers))
  wrap.appendChild(drawStrip(view, strips.post, files, setKey, handlers))
  return wrap
}

/** The picker for a Pre-work or Post-work row: file names, with the file's id as the value written. */
export function drawWorkFileSelect(key: 'prework' | 'postwork', current: string, files: StripFile[], setKey: SetKey): HTMLSelectElement {
  const select = el('select', 'cm-fm-select')
  select.dataset.workFilePicker = key
  const none = el('option', undefined, 'No file')
  none.value = ''
  select.appendChild(none)
  // The file the value names is read as the strips and the Work files view read it (work-file-name.ts).
  const named = talkWorkFile(current, files)
  let matched = named.name === '' || named.file !== null
  for (const file of files) {
    const value = workFileValue(file)
    const item = el('option', undefined, value ? file.title : `${file.title} (${NO_ID})`)
    // A file with no id cannot be chosen (a Run names files by id); it stays shown, and selected when the talk names it.
    item.value = value || `\u0000${file.fileName}`
    item.title = value || NO_ID
    item.disabled = !value
    if (file === named.file) item.selected = true
    select.appendChild(item)
  }
  if (!matched) {
    const custom = el('option', undefined, `custom: ${current}`)
    custom.value = current
    custom.selected = true
    select.appendChild(custom)
  }
  select.addEventListener('change', () => {
    if (select.value.startsWith('\u0000')) return // a file with no id: never written
    setKey(key, select.value === '' ? null : select.value)
  })
  return select
}
