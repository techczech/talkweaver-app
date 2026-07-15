// Renders the YAML frontmatter (`--- … ---`) as an inline TABLE of typed controls
// (dropdowns for enums, checkboxes for flags, text for the rest), with a raw ↔ table toggle.
// Editing a control rewrites the frontmatter block in the doc; the table is the default view.
import { EditorView, Decoration, DecorationSet, WidgetType } from '@codemirror/view'
import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'

// ── frontmatter parse / serialize ─────────────────────────────────────────────
interface Pair { key: string; value: string }
interface Parsed { from: number; to: number; pairs: Pair[] }

// Locate the `--- … ---` block at the very top and parse its flat key: value lines.
function parseFrontmatter(state: EditorState): Parsed | null {
  const doc = state.doc
  if (doc.lines < 2) return null
  if (doc.line(1).text.trim() !== '---') return null
  let closing = -1
  for (let n = 2; n <= doc.lines; n += 1) {
    if (doc.line(n).text.trim() === '---') { closing = n; break }
  }
  if (closing < 0) return null
  const pairs: Pair[] = []
  for (let n = 2; n < closing; n += 1) {
    const t = doc.line(n).text
    const m = t.match(/^([A-Za-z0-9_-]+):\s?(.*)$/)
    if (m) pairs.push({ key: m[1], value: unquote(m[2]) })
  }
  return { from: doc.line(1).from, to: doc.line(closing).to, pairs }
}
function unquote(s: string): string {
  const t = s.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).replace(/\\"/g, '"')
  }
  return t
}
function serializeValue(v: string): string {
  if (v === 'true' || v === 'false') return v
  if (v === '') return '""'
  if (/[:#"']/.test(v) || /^\s|\s$/.test(v)) return '"' + v.replace(/"/g, '\\"') + '"'
  return v
}
function serialize(pairs: Pair[]): string {
  return '---\n' + pairs.map((p) => `${p.key}: ${serializeValue(p.value)}`).join('\n') + '\n---'
}

// ── known field definitions (what gets a typed control) ───────────────────────
type FieldType = 'text' | 'bool' | 'select'
interface FieldDef { key: string; label: string; type: FieldType; options?: string[]; placeholder?: string }
const FIELDS: FieldDef[] = [
  { key: 'title', label: 'Title', type: 'text' },
  { key: 'subtitle', label: 'Subtitle / event', type: 'text' },
  { key: 'event', label: 'Event', type: 'text' },
  { key: 'author', label: 'Author', type: 'text' },
  { key: 'duration', label: 'Duration', type: 'text', placeholder: '45min · 1:30 · 90' },
  { key: 'auto_title_slide', label: 'Auto title slide', type: 'bool' },
  { key: 'auto_thanks_slide', label: 'Auto thanks slide', type: 'bool' },
  { key: 'section_labels', label: 'Section labels on slides', type: 'bool' },
  { key: 'thanks', label: 'Thanks text', type: 'text' },
  { key: 'cta', label: 'Call to action', type: 'text' },
  { key: 'palette', label: 'Palette', type: 'select', options: ['', 'green'] },
  { key: 'handout_url', label: 'Handout URL', type: 'text', placeholder: 'https://your-project.pages.dev/…' },
  { key: 'license', label: 'License', type: 'select', options: ['', 'by', 'by-sa', 'by-nc', 'by-nd', 'by-nc-sa', 'by-nc-nd', 'CC0'] },
  { key: 'license-note', label: 'License note', type: 'text' },
  { key: 'triggers', label: 'Deck-wide triggers', type: 'text', placeholder: 'reveal numbered …' }
]
const FIELD_BY_KEY = new Map(FIELDS.map((f) => [f.key, f]))

// ── raw ↔ table toggle (StateField) ───────────────────────────────────────────
const toggleRawEffect = StateEffect.define<boolean>()
const rawField = StateField.define<boolean>({
  create: () => false, // table view by default
  update(value, tr) {
    for (const e of tr.effects) if (e.is(toggleRawEffect)) return e.value
    return value
  }
})

// Replace the frontmatter `pairs` and write back to the document.
function writeBack(view: EditorView, parsed: Parsed, pairs: Pair[]): void {
  view.dispatch({ changes: { from: parsed.from, to: parsed.to, insert: serialize(pairs) } })
}

class FrontmatterWidget extends WidgetType {
  constructor(private readonly pairs: Pair[]) {
    super()
  }
  eq(other: FrontmatterWidget): boolean {
    return JSON.stringify(other.pairs) === JSON.stringify(this.pairs)
  }
  // Declare the rendered height so CodeMirror maps click coordinates for the lines BELOW the
  // widget correctly (without this, clicks in the body land one line off).
  get estimatedHeight(): number {
    return 38 /* header */ + this.pairs.length * 26 /* rows */ + 34 /* add control + padding */
  }
  ignoreEvent(): boolean {
    return true // let the inputs handle their own events
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-frontmatter-table'
    wrap.dataset.frontmatterTable = 'true'

    const header = document.createElement('div')
    header.className = 'cm-fm-header'
    const title = document.createElement('span')
    title.textContent = 'Metadata'
    header.appendChild(title)
    const rawBtn = document.createElement('button')
    rawBtn.type = 'button'
    rawBtn.className = 'cm-fm-raw-btn'
    rawBtn.textContent = '</> raw'
    rawBtn.title = 'Edit raw YAML'
    rawBtn.addEventListener('mousedown', (e) => {
      e.preventDefault()
      view.dispatch({ effects: toggleRawEffect.of(true) })
    })
    header.appendChild(rawBtn)
    wrap.appendChild(header)

    const setKey = (key: string, value: string | null): void => {
      const parsed = parseFrontmatter(view.state)
      if (!parsed) return
      const pairs = parsed.pairs.slice()
      const idx = pairs.findIndex((p) => p.key === key)
      if (value === null) {
        if (idx >= 0) pairs.splice(idx, 1)
      } else if (idx >= 0) {
        pairs[idx] = { key, value }
      } else {
        pairs.push({ key, value })
      }
      writeBack(view, parsed, pairs)
    }

    const grid = document.createElement('div')
    grid.className = 'cm-fm-grid'

    const present = new Map(this.pairs.map((p) => [p.key, p.value]))
    // Render present pairs in document order; known keys get typed controls.
    for (const p of this.pairs) {
      grid.appendChild(makeRow(p.key, p.value, setKey))
    }
    wrap.appendChild(grid)

    // "+ add field" — surface known keys that aren't set yet.
    const unset = FIELDS.filter((f) => !present.has(f.key) && !(f.key === 'event' && present.has('subtitle')))
    if (unset.length) {
      const add = document.createElement('select')
      add.className = 'cm-fm-add'
      const ph = document.createElement('option')
      ph.value = ''
      ph.textContent = '+ add field…'
      add.appendChild(ph)
      for (const f of unset) {
        const o = document.createElement('option')
        o.value = f.key
        o.textContent = f.label
        add.appendChild(o)
      }
      add.addEventListener('change', () => {
        if (add.value) setKey(add.value, FIELD_BY_KEY.get(add.value)?.type === 'bool' ? 'true' : '')
      })
      wrap.appendChild(add)
    }

    return wrap
  }
}

function makeRow(
  key: string,
  value: string,
  setKey: (key: string, value: string | null) => void
): HTMLElement {
  const def = FIELD_BY_KEY.get(key)
  const row = document.createElement('div')
  row.className = 'cm-fm-row'
  row.dataset.fmKey = key

  const label = document.createElement('label')
  label.className = 'cm-fm-label'
  label.textContent = def ? def.label : key
  row.appendChild(label)

  let control: HTMLElement
  if (def?.type === 'bool') {
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.className = 'cm-fm-checkbox'
    cb.checked = value === 'true'
    cb.addEventListener('change', () => setKey(key, cb.checked ? 'true' : 'false'))
    control = cb
  } else if (def?.type === 'select') {
    const sel = document.createElement('select')
    sel.className = 'cm-fm-select'
    const opts = def.options ?? []
    const all = opts.includes(value) ? opts : [...opts, value]
    for (const o of all) {
      const opt = document.createElement('option')
      opt.value = o
      opt.textContent = o === '' ? '(default)' : o
      if (o === value) opt.selected = true
      sel.appendChild(opt)
    }
    sel.addEventListener('change', () => setKey(key, sel.value))
    control = sel
  } else {
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'cm-fm-input'
    input.value = value
    if (def?.placeholder) input.placeholder = def.placeholder
    input.addEventListener('change', () => setKey(key, input.value))
    control = input
  }
  row.appendChild(control)

  // remove (×) — unknown keys + optional known keys can be cleared
  const del = document.createElement('button')
  del.type = 'button'
  del.className = 'cm-fm-del'
  del.textContent = '×'
  del.title = 'Remove field'
  del.addEventListener('mousedown', (e) => { e.preventDefault(); setKey(key, null) })
  row.appendChild(del)

  return row
}

// A line-end widget shown in RAW mode, carrying a "table" button to flip back.
class RawToggleWidget extends WidgetType {
  eq(): boolean { return true }
  toDOM(view: EditorView): HTMLElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'cm-fm-table-btn'
    btn.textContent = '⊞ table'
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
