// Renders the YAML frontmatter (`--- … ---`) as an inline TABLE of typed controls, with a
// raw ↔ table toggle. Editing a control rewrites the frontmatter block in the doc; the table is
// the default view.
//
// EVERY label, control type, choice and explanation comes from the metadata registry through
// `frontmatterSurfaceViewModel` (src/shared/metadata-surfaces.ts). This file must never carry its
// own field list again: it used to know 15 keys with hand-written labels and no explanations,
// which is exactly why two thirds of the deck settings were unreachable here.
//
// Writes go through the shared byte-preserving `editFrontmatterText`, so comments and nested map
// blocks (`defaults:`, `sections:`, `icons:`) survive an edit to an unrelated field.
import { EditorView, Decoration, type DecorationSet, WidgetType } from '@codemirror/view'
import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { METADATA_REGISTRY } from '../../../shared/metadata-registry.ts'
import {
  frontmatterSurfaceViewModel,
  initialValueFor,
  type SurfaceFieldModel,
  type SurfaceOptionModel
} from '../../../shared/metadata-surfaces.ts'
import { editFrontmatterText, parseFrontmatterPairs } from '../../../shared/frontmatter-editor.ts'
import { metadataDefaultsSnapshot } from '../lib/metadata-defaults.ts'

// ── frontmatter parse / serialize ─────────────────────────────────────────────
interface Pair { key: string; value: string }
interface Parsed { from: number; to: number; text: string; pairs: Pair[] }

// Locate the `--- … ---` block at the very top and parse it with the SHARED parser, so the table
// and Deck settings never disagree about what a key holds.
function parseFrontmatter(state: EditorState): Parsed | null {
  const doc = state.doc
  if (doc.lines < 2) return null
  if (doc.line(1).text.trim() !== '---') return null
  let closing = -1
  for (let n = 2; n <= doc.lines; n += 1) {
    if (doc.line(n).text.trim() === '---') { closing = n; break }
  }
  if (closing < 0) return null
  const from = doc.line(1).from
  const to = doc.line(closing).to
  const text = doc.sliceString(from, to)
  return { from, to, text, pairs: parseFrontmatterPairs(text) }
}

// ── raw ↔ table toggle (StateField) ───────────────────────────────────────────
const toggleRawEffect = StateEffect.define<boolean>()
const rawField = StateField.define<boolean>({
  create: () => false, // table view by default
  update(value, tr) {
    for (const e of tr.effects) if (e.is(toggleRawEffect)) return e.value
    return value
  }
})

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

// Exported for the DOM gate (scripts/test-frontmatter-table-dom.mjs), which drives the "?"
// disclosure directly. The widget is otherwise internal to this extension.
export class FrontmatterWidget extends WidgetType {
  readonly pairs: Pair[]
  constructor(pairs: Pair[]) {
    super()
    this.pairs = pairs
  }
  eq(other: FrontmatterWidget): boolean {
    return JSON.stringify(other.pairs) === JSON.stringify(this.pairs)
  }
  // Declare the rendered height so CodeMirror maps click coordinates for the lines BELOW the
  // widget correctly (without this, clicks in the body land one line off). Rows are collapsed by
  // default — the explanation lives behind the row's "?" (T27) — so a collapsed row measures about
  // 40px; opening a help block calls view.requestMeasure(), which re-measures the real DOM height.
  get estimatedHeight(): number {
    return 38 /* header */ + this.pairs.length * 40 /* collapsed rows */ + 34 /* add control + padding */
  }
  ignoreEvent(): boolean {
    return true // let the inputs handle their own events
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = el('div', 'cm-frontmatter-table')
    wrap.dataset.frontmatterTable = 'true'

    const header = el('div', 'cm-fm-header')
    header.appendChild(el('span', undefined, 'Metadata'))
    const rawBtn = el('button', 'cm-fm-raw-btn', '</> raw')
    rawBtn.type = 'button'
    rawBtn.title = 'Edit raw YAML'
    rawBtn.addEventListener('mousedown', (e) => {
      e.preventDefault()
      view.dispatch({ effects: toggleRawEffect.of(true) })
    })
    header.appendChild(rawBtn)
    wrap.appendChild(header)

    // One edit through the shared byte-preserving editor: comments, nested maps and unrelated
    // keys keep their bytes, and an alias spelling already in the file is edited in place.
    const setKey = (key: string, value: string | null, aliases: string[] = [], raw = false): void => {
      const parsed = parseFrontmatter(view.state)
      if (!parsed) return
      const next = editFrontmatterText(parsed.text, [{ key, value, aliases, raw }])
      if (next === parsed.text) return
      view.dispatch({ changes: { from: parsed.from, to: parsed.to, insert: next } })
    }

    const model = frontmatterSurfaceViewModel(METADATA_REGISTRY, this.pairs)

    // Settings → Presenter identity and deck defaults: shown as placeholder text so an empty
    // field says what it WOULD be, without writing anything. Refreshed on the next doc change.
    const defaults = metadataDefaultsSnapshot()

    const grid = el('div', 'cm-fm-grid')
    for (const row of model.rows) grid.appendChild(makeRow(row, setKey, defaults[row.key] ?? '', () => view.requestMeasure()))
    wrap.appendChild(grid)

    // "+ add field" — every registry key not yet written, grouped and ordered by the registry.
    if (model.addable.length > 0) {
      const add = el('select', 'cm-fm-add')
      add.title = 'Add a deck setting to this outline'
      const placeholder = el('option', undefined, '+ add field…')
      placeholder.value = ''
      add.appendChild(placeholder)
      const groups = new Map<string, HTMLOptGroupElement>()
      for (const option of model.addable) {
        let group = groups.get(option.group)
        if (!group) {
          group = document.createElement('optgroup')
          group.label = option.group
          groups.set(option.group, group)
          add.appendChild(group)
        }
        const item = el('option', undefined, option.label)
        item.value = option.key
        item.title = option.explanation
        group.appendChild(item)
      }
      add.addEventListener('change', () => {
        const entry = METADATA_REGISTRY.find((candidate) => candidate.key === add.value)
        if (entry) setKey(entry.key, initialValueFor(entry), entry.aliases ?? [])
      })
      wrap.appendChild(add)
    }

    return wrap
  }
}

type SetKey = (key: string, value: string | null, aliases?: string[], raw?: boolean) => void

/** The expandable list of what each documented choice actually does. */
function makeChoiceList(options: SurfaceOptionModel[]): HTMLElement {
  const details = el('details', 'cm-fm-choices')
  details.appendChild(el('summary', undefined, 'What each choice does'))
  const list = el('dl', 'cm-fm-choice-list')
  for (const option of options) {
    list.appendChild(el('dt', undefined, option.label))
    list.appendChild(el('dd', undefined, option.explanation))
  }
  details.appendChild(list)
  return details
}

function makePicker(field: SurfaceFieldModel, setKey: SetKey): HTMLElement {
  const options = field.options as SurfaceOptionModel[]
  const write = (value: string): void =>
    setKey(field.key, value === '' ? null : value, field.aliases, field.control === 'map')
  if (field.control === 'select') {
    const select = el('select', 'cm-fm-select')
    if (!options.some((option) => option.value === field.value)) {
      const current = el('option', undefined, `custom: ${field.value}`)
      current.value = field.value
      current.selected = true
      select.appendChild(current)
    }
    for (const option of options) {
      const item = el('option', undefined, option.label)
      item.value = option.value
      item.title = option.explanation
      if (option.selected) item.selected = true
      select.appendChild(item)
    }
    select.addEventListener('change', () => write(select.value))
    return select
  }
  const group = el('div', 'cm-fm-seg')
  group.setAttribute('role', 'group')
  group.setAttribute('aria-label', field.label)
  for (const option of options) {
    const button = el('button', 'cm-fm-seg-btn', option.label)
    button.type = 'button'
    button.title = option.explanation
    button.setAttribute('aria-pressed', option.selected ? 'true' : 'false')
    if (option.selected) button.classList.add('is-on')
    if (option.swatch) {
      const swatch = el('span', 'cm-fm-swatch')
      swatch.style.background = option.swatch
      button.prepend(swatch)
    }
    button.addEventListener('mousedown', (e) => { e.preventDefault(); write(option.value) })
    group.appendChild(button)
  }
  return group
}

function makeControl(field: SurfaceFieldModel, setKey: SetKey, appDefault: string): HTMLElement {
  if (field.readOnly || field.control === 'map') {
    const value = el('div', 'cm-fm-ro', field.value.trim() ? field.value.trim() : '(not set)')
    return value
  }
  if (field.options) return makePicker(field, setKey)
  const input = el('input', 'cm-fm-input')
  input.type = field.control === 'url' ? 'url' : field.control === 'number' ? 'number' : 'text'
  input.value = field.value
  input.placeholder = appDefault ? `${appDefault} (your default)` : (field.placeholder ?? '')
  input.addEventListener('change', () => setKey(field.key, input.value === '' ? null : input.value, field.aliases))
  return input
}

function makeRow(field: SurfaceFieldModel, setKey: SetKey, appDefault = '', requestMeasure: () => void = () => {}): HTMLElement {
  const row = el('div', 'cm-fm-row')
  row.dataset.fmKey = field.key
  if (field.readOnly) row.classList.add('is-readonly')

  const main = el('div', 'cm-fm-rowmain')
  const label = el('label', 'cm-fm-label', field.label)
  label.title = field.key
  main.appendChild(label)
  main.appendChild(makeControl(field, setKey, appDefault))
  if (field.unit) main.appendChild(el('span', 'cm-fm-unit', field.unit))

  if (!field.readOnly) {
    const del = el('button', 'cm-fm-del', '×')
    del.type = 'button'
    del.title = `Remove ${field.label}`
    del.addEventListener('mousedown', (e) => { e.preventDefault(); setKey(field.key, null, field.aliases) })
    main.appendChild(del)
  }

  // T27: the explanation and notes live behind a small round "?" at the right end of the row
  // instead of sitting in the always-visible flow (reverses the 2026-06 decision recorded in
  // styles.css — Dominik, 2026-09-17). Click / Enter / Space toggles the block; Escape, while the
  // button or the opened block has focus, closes it and returns focus to the button.
  const helpId = `cm-fm-help-${field.key}`
  const helpBlock = el('div', 'cm-fm-helpblock')
  helpBlock.id = helpId
  helpBlock.hidden = true
  helpBlock.tabIndex = -1
  helpBlock.appendChild(el('div', 'cm-fm-help', field.explanation))
  if (appDefault && field.options) {
    helpBlock.appendChild(el('div', 'cm-fm-note', `Your default: ${appDefault} — set in Settings → Presenter identity and deck defaults.`))
  }
  if (field.note) helpBlock.appendChild(el('div', 'cm-fm-note', field.note))
  if (field.control === 'map' && !field.readOnly) {
    helpBlock.appendChild(el('div', 'cm-fm-note', 'Structured value — edit it in Deck settings or the raw view.'))
  }
  if (field.custom) {
    helpBlock.appendChild(el('div', 'cm-fm-note', `This outline holds “${field.custom.value}”, which is not one of the documented choices. Pick one to return to them.`))
  }
  if (field.options) helpBlock.appendChild(makeChoiceList(field.options))

  const helpBtn = el('button', 'cm-fm-help-btn', '?')
  helpBtn.type = 'button'
  helpBtn.setAttribute('aria-label', `Explain ${field.label}`)
  helpBtn.setAttribute('aria-expanded', 'false')
  helpBtn.setAttribute('aria-controls', helpId)
  helpBtn.title = field.explanation.match(/^[^.!?]+[.!?]/)?.[0]?.trim() ?? field.explanation
  const setExpanded = (open: boolean): void => {
    helpBlock.hidden = !open
    helpBtn.setAttribute('aria-expanded', open ? 'true' : 'false')
    requestMeasure()
  }
  helpBtn.addEventListener('click', () => setExpanded(helpBlock.hidden))
  helpBtn.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !helpBlock.hidden) setExpanded(false)
  })
  helpBlock.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      setExpanded(false)
      helpBtn.focus()
    }
  })
  main.appendChild(helpBtn)
  row.appendChild(main)
  row.appendChild(helpBlock)
  return row
}

// A line-end widget shown in RAW mode, carrying a "table" button to flip back.
class RawToggleWidget extends WidgetType {
  eq(): boolean { return true }
  toDOM(view: EditorView): HTMLElement {
    const btn = el('button', 'cm-fm-table-btn', '⊞ table')
    btn.type = 'button'
    btn.title = 'Edit metadata as a table'
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault()
      view.dispatch({ effects: toggleRawEffect.of(false) })
    })
    return btn
  }
}

// Build the decoration set from STATE (block decorations must come from a StateField, not a
// view plugin — CodeMirror rejects block decorations specified via plugins). Table mode → a
// block replace over the frontmatter; raw mode → an inline "⊞ table" toggle on the opening ---.
function buildDecorations(state: EditorState): DecorationSet {
  const parsed = parseFrontmatter(state)
  if (!parsed) return Decoration.none
  if (state.field(rawField)) {
    const line = state.doc.lineAt(parsed.from)
    return Decoration.set([
      Decoration.widget({ widget: new RawToggleWidget(), side: 1 }).range(line.to)
    ])
  }
  return Decoration.set([
    Decoration.replace({ widget: new FrontmatterWidget(parsed.pairs), block: true }).range(
      parsed.from,
      parsed.to
    )
  ])
}

const frontmatterDecoField = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state),
  update(deco, tr) {
    if (tr.docChanged || tr.effects.some((e) => e.is(toggleRawEffect))) {
      return buildDecorations(tr.state)
    }
    return deco.map(tr.changes)
  },
  provide: (f) => EditorView.decorations.from(f)
})

export function frontmatterTableExtension(): Extension {
  return [rawField, frontmatterDecoField]
}
