// The Inspector's Board section (ADR-0032 §2; round-3 A2–A6, round-2 E5): a `{poll=board}` slide's
// prompt and instructions, example card, columns with their hints, settings and preview. The slide
// text stays the truth: every field writes the slide body through the board edit path
// (board-slide.mjs applyBoardEditToOutline), the settings write the Trigger line through the
// ordinary option commit. A field keeps what the user is typing while the source catches up, and
// takes the source again the moment it changes from anywhere else (the editor, undo).
import { useEffect, useRef, useState } from 'react'
import { EyeOff, GripVertical, MonitorSmartphone, Plus, Smartphone, X } from 'lucide-react'
import type { BoardEdit } from '../../../../compiler/scripts/lib/board-slide.mjs'
import {
  BOARD_COLUMN_RANGE, BOARD_TEXT_LIMITS, boardColumnsKey, boardCounter, moveBoardColumn, writtenBoardColumns,
  type InspectorBoardModel
} from './inspectorBoardModel'

interface Props {
  board: InspectorBoardModel
  /** The inspected slide: a new slide starts every field afresh. */
  slideKey: string
  /** Writes one edit to the slide text; false when it could not be written (the field reverts). */
  onEdit: (edit: BoardEdit) => boolean
  /** The board's settings rows (the registry's board-* groups), rendered by the Inspector. */
  settings: React.ReactNode
}

interface ColumnRow { id: number; label: string; hint: string; extra: string[]; raw?: InspectorBoardModel['columns'][number]['raw'] }

const oneLine = (text: string): string => text.replace(/\s*[\r\n]+\s*/g, ' ').trim()

// Keys typed into a field belong to the field: the app's single-key shortcuts must not see them.
// ⌥↑/⌥↓ still move between slides (the Inspector's own keys).
const keepKeys = (event: React.KeyboardEvent): void => {
  if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) return
  event.stopPropagation()
  // Home/End in a one-line field move the caret here: left to Chromium, an End the field cannot use
  // (the caret already at the end) scrolls the whole options pane to its foot.
  const field = event.target
  if ((event.key === 'Home' || event.key === 'End') && field instanceof HTMLInputElement
    && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault()
    const at = event.key === 'End' ? field.value.length : 0
    field.setSelectionRange(at, at)
  }
}

/** One text field bound to a part of the slide text. */
function useSourceField(source: string, slideKey: string): [string, (value: string) => void, (value: string) => void] {
  const [draft, setDraft] = useState(source)
  const written = useRef(oneLine(source))
  const slide = useRef(slideKey)
  useEffect(() => {
    if (slide.current !== slideKey) {
      slide.current = slideKey
      written.current = oneLine(source)
      setDraft(source)
      return
    }
    if (oneLine(source) !== written.current) {
      written.current = oneLine(source)
      setDraft(source)
    }
  }, [source, slideKey])
  const markWritten = (value: string): void => { written.current = oneLine(value) }
  return [draft, setDraft, markWritten]
}

function Counter({ text, limit }: { text: string; limit: number }): React.JSX.Element {
  const counter = boardCounter(text, limit)
  return <span className={`tw-board-counter${counter.over ? ' is-over' : ''}`} aria-hidden="true">{counter.label}</span>
}

export default function InspectorBoard({ board, slideKey, onEdit, settings }: Props): React.JSX.Element {
  // ── Prompt and instructions ────────────────────────────────────────────────────────────────
  const [question, setQuestion, questionWritten] = useSourceField(board.question, slideKey)
  const [instructions, setInstructions, instructionsWritten] = useSourceField(board.instructions, slideKey)
  const [exampleText, setExampleText, exampleWritten] = useSourceField(board.example ?? '', slideKey)
  const [exampleOn, setExampleOn] = useState(board.example !== null)
  const exampleRef = useRef<HTMLInputElement | null>(null)
  const exampleSlide = useRef(slideKey)
  useEffect(() => {
    // The toggle follows the source whenever the source has an example, or on a new slide.
    if (exampleSlide.current !== slideKey || board.example !== null) setExampleOn(board.example !== null)
    exampleSlide.current = slideKey
  }, [board.example, slideKey])

  const writeQuestion = (value: string): void => {
    setQuestion(value)
    if (!oneLine(value)) return // a slide keeps its title; an empty question is not written
    questionWritten(value)
    if (!onEdit({ kind: 'question', text: value })) setQuestion(board.question)
  }
  const writeInstructions = (value: string): void => {
    setInstructions(value)
    instructionsWritten(value)
    if (!onEdit({ kind: 'instructions', text: value })) setInstructions(board.instructions)
  }
  const writeExample = (value: string): void => {
    setExampleText(value)
    exampleWritten(value)
    if (!onEdit({ kind: 'example', text: oneLine(value) ? value : null })) setExampleText(board.example ?? '')
  }
  const toggleExample = (on: boolean): void => {
    setExampleOn(on)
    if (on) { requestAnimationFrame(() => exampleRef.current?.focus()); if (oneLine(exampleText)) writeExample(exampleText); return }
    exampleWritten('')
    onEdit({ kind: 'example', text: null })
  }

  // ── Columns ────────────────────────────────────────────────────────────────────────────────
  const nextId = useRef(1)
  const rowsFrom = (columns: InspectorBoardModel['columns']): ColumnRow[] =>
    columns.map((column) => ({ id: nextId.current++, label: column.label, hint: column.hint, extra: [...column.extra], raw: column.raw }))
  const [rows, setRows] = useState<ColumnRow[]>(() => rowsFrom(board.columns))
  const writtenColumns = useRef(boardColumnsKey(board.columns))
  const columnsSlide = useRef(slideKey)
  useEffect(() => {
    const key = boardColumnsKey(board.columns)
    if (columnsSlide.current !== slideKey || key !== writtenColumns.current) {
      columnsSlide.current = slideKey
      writtenColumns.current = key
      setRows(rowsFrom(board.columns))
    }
  }, [board.columns, slideKey])
  const focusName = useRef<number | null>(null)
  const nameRefs = useRef(new Map<number, HTMLInputElement>())
  const handleRefs = useRef(new Map<number, HTMLButtonElement>())
  useEffect(() => {
    if (focusName.current == null) return
    nameRefs.current.get(focusName.current)?.focus()
    focusName.current = null
  })

  const writeRows = (next: ColumnRow[]): void => {
    setRows(next)
    const key = boardColumnsKey(next)
    if (key === writtenColumns.current) return
    writtenColumns.current = key
    if (!onEdit({ kind: 'columns', columns: writtenBoardColumns(next) })) {
      writtenColumns.current = boardColumnsKey(board.columns)
      setRows(rowsFrom(board.columns))
    }
  }
  const named = rows.filter((row) => row.label.trim()).length
  const updateRow = (id: number, patch: Partial<ColumnRow>): void =>
    writeRows(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  const removeRow = (id: number): void => writeRows(rows.filter((row) => row.id !== id))
  const addRow = (): void => {
    if (rows.length >= BOARD_COLUMN_RANGE.max) return
    const row = { id: nextId.current++, label: '', hint: '', extra: [] }
    focusName.current = row.id
    setRows([...rows, row]) // nothing is written until the new column has a name
  }
  const moveRow = (from: number, to: number): void => {
    if (to < 0 || to >= rows.length || from === to) return
    writeRows(moveBoardColumn(rows, from, to))
  }
  // A row whose name was emptied and left goes: it was never (or is no longer) in the text.
  const leaveRow = (id: number): void => {
    const row = rows.find((candidate) => candidate.id === id)
    if (row && !row.label.trim()) setRows(rows.filter((candidate) => candidate.id !== id))
  }

  // Drag a row by its handle; the line shows where it lands (A2 reorder).
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null)
  const dropIndexAt = (event: React.DragEvent<HTMLElement>, index: number): number => {
    const rect = event.currentTarget.getBoundingClientRect()
    return event.clientY < rect.top + rect.height / 2 ? index : index + 1
  }
  const finishDrag = (): void => {
    if (drag) {
      const to = drag.to > drag.from ? drag.to - 1 : drag.to
      moveRow(drag.from, to)
    }
    setDrag(null)
  }

  // The line shows only where a drop would move the row.
  const dropLine = drag && drag.to !== drag.from && drag.to !== drag.from + 1 ? drag.to : null

  const fewColumns = board.findings.some((finding) => finding.code === 'board-columns-few')
  const manyColumns = board.findings.some((finding) => finding.code === 'board-columns-many')

  return (
    <div className="tw-board" data-board-slide={slideKey}>
      <div className="tw-inspector-group tw-board-group" data-group="board-prompt">
        <span className="tw-inspector-group-label">Prompt and instructions</span>
        <label className="tw-board-field">
          <span className="tw-board-field-label">Question <small>· the slide’s title</small></span>
          <span className="tw-board-input">
            <input type="text" value={question} aria-label="Question"
              onChange={(event) => writeQuestion(event.currentTarget.value)}
              onBlur={() => { if (!oneLine(question)) setQuestion(board.question) }}
              onKeyDown={keepKeys} />
          </span>
        </label>
        <label className="tw-board-field">
          <span className="tw-board-field-label">Instructions <small>· the paragraph under the title</small></span>
          <span className="tw-board-input tw-board-input--area">
            <textarea value={instructions} rows={3} aria-label="Instructions"
              onChange={(event) => writeInstructions(event.currentTarget.value.replace(/[\r\n]+/g, ' '))}
              onKeyDown={(event) => { keepKeys(event); if (event.key === 'Enter') event.preventDefault() }} />
            <Counter text={oneLine(instructions)} limit={BOARD_TEXT_LIMITS.instructions} />
          </span>
        </label>
        <div className="tw-board-field">
          <span className="tw-board-field-label">Example card <small>· the “&gt;” line, shown dashed and never counted</small></span>
          <div className="layout-option-segments tw-board-toggle" role="group" aria-label="Example card">
            <button type="button" aria-pressed={!exampleOn} className={!exampleOn ? 'is-selected' : undefined} onClick={() => toggleExample(false)}>Off</button>
            <button type="button" aria-pressed={exampleOn} className={exampleOn ? 'is-selected' : undefined} onClick={() => toggleExample(true)}>On</button>
          </div>
          {exampleOn && (
            <span className="tw-board-input">
              <input ref={exampleRef} type="text" value={exampleText} aria-label="Example card" placeholder="An example of a good card"
                onChange={(event) => writeExample(event.currentTarget.value)} onKeyDown={keepKeys} />
              <Counter text={oneLine(exampleText)} limit={BOARD_TEXT_LIMITS.example} />
            </span>
          )}
        </div>
        <p className="tw-board-note"><MonitorSmartphone aria-hidden="true" /> Shown under the question on the big screen and above the tabs on phones and laptops.</p>
      </div>

      <div className="tw-inspector-group tw-board-group" data-group="board-columns">
        <span className="tw-inspector-group-label">Columns</span>
        <ol className="tw-board-columns" aria-label="Columns">
          {rows.map((row, index) => (
            <li
              key={row.id}
              className={`tw-board-column${drag?.from === index ? ' is-dragging' : ''}${dropLine === index ? ' is-drop-before' : ''}${dropLine === rows.length && index === rows.length - 1 ? ' is-drop-after' : ''}`}
              data-column-index={index}
              onDragOver={(event) => { if (!drag) return; event.preventDefault(); setDrag({ ...drag, to: dropIndexAt(event, index) }) }}
              onDrop={(event) => { event.preventDefault(); finishDrag() }}
            >
              <button
                type="button"
                className="tw-board-handle"
                ref={(element) => { if (element) handleRefs.current.set(row.id, element); else handleRefs.current.delete(row.id) }}
                draggable
                aria-label={`Move column ${row.label || index + 1} (↑ ↓)`}
                title="Drag to reorder, or press ↑ ↓"
                onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(index)); setDrag({ from: index, to: index }) }}
                onDragEnd={() => setDrag(null)}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
                  if (event.altKey) return
                  event.preventDefault()
                  event.stopPropagation()
                  const to = index + (event.key === 'ArrowUp' ? -1 : 1)
                  moveRow(index, to)
                  // The moved row keeps its id: its handle keeps the focus.
                  requestAnimationFrame(() => handleRefs.current.get(row.id)?.focus())
                }}
              ><GripVertical aria-hidden="true" /></button>
              <span className="tw-board-input tw-board-input--name">
                <input
                  ref={(element) => { if (element) nameRefs.current.set(row.id, element); else nameRefs.current.delete(row.id) }}
                  type="text" value={row.label} placeholder="Column name" aria-label={`Column ${index + 1} name`}
                  onChange={(event) => updateRow(row.id, { label: event.currentTarget.value })}
                  onBlur={() => leaveRow(row.id)}
                  onKeyDown={keepKeys} />
                <Counter text={row.label.trim()} limit={BOARD_TEXT_LIMITS.name} />
              </span>
              <button type="button" className="tw-board-remove" aria-label={`Remove column ${row.label || index + 1}`}
                title={named <= BOARD_COLUMN_RANGE.min && row.label.trim() ? 'A board needs at least two columns' : 'Remove this column'}
                disabled={named <= BOARD_COLUMN_RANGE.min && Boolean(row.label.trim())}
                onClick={() => removeRow(row.id)}><X aria-hidden="true" /></button>
              <span className="tw-board-input tw-board-input--hint">
                <input type="text" value={row.hint} placeholder="One line shown to participants (optional)" aria-label={`Column ${index + 1} hint`}
                  onChange={(event) => updateRow(row.id, { hint: event.currentTarget.value })} onKeyDown={keepKeys} />
                {row.hint.trim() && <Counter text={row.hint.trim()} limit={BOARD_TEXT_LIMITS.hint} />}
              </span>
            </li>
          ))}
        </ol>
        <div className="tw-board-add">
          <button type="button" onClick={addRow} disabled={rows.length >= BOARD_COLUMN_RANGE.max}
            title={rows.length >= BOARD_COLUMN_RANGE.max ? 'A board has at most four columns' : 'Add a column'}><Plus aria-hidden="true" /> Add a column</button>
          <span className="tw-board-count">{named} of {BOARD_COLUMN_RANGE.max}</span>
        </div>
        {fewColumns && <p className="tw-board-finding" role="status">A board needs at least two columns.</p>}
        {manyColumns && <p className="tw-board-finding" role="status">A board shows only its first four columns.</p>}
        <p className="tw-board-note">A name is a tab on the phone, so keep it short. The hint is the card box’s placeholder on phones and shows in an empty column on the big screen.</p>
      </div>

      <div className="tw-inspector-group tw-board-group tw-board-settings" data-group="board-settings">
        <span className="tw-inspector-group-label">Settings</span>
        {settings}
        <p className="tw-board-note"><EyeOff aria-hidden="true" /> Names are off unless you allow them; a name is always optional and only you see it. A board left open after the talk closes by itself, and you can close it sooner in History.</p>
        <p className="tw-board-trigger"><span>Trigger line</span><code>{board.triggerText || '{poll=board}'}</code></p>
        <p className="tw-board-note">Only settings that differ from the defaults are written (24, 140, 5, off, 7 days).</p>
      </div>

      <div className="tw-inspector-group tw-board-group" data-group="board-preview">
        <span className="tw-inspector-group-label">Preview</span>
        <div className="tw-board-preview">
          <BoardPhonePreview board={board} question={question} />
          <div className="tw-board-preview-notes">
            <p><strong>Big screen</strong><span><MonitorSmartphone aria-hidden="true" /> The preview above shows it: hints and the example card appear while a column is empty.</span></p>
            <p><strong>Phone and laptop</strong><span><Smartphone aria-hidden="true" /> What a phone shows on this slide. A laptop shows the same in a panel beside the slide.</span></p>
          </div>
        </div>
      </div>
    </div>
  )
}

/** The phone's look on this slide before anyone has added a card (text only). */
function BoardPhonePreview({ board, question }: { board: InspectorBoardModel; question: string }): React.JSX.Element {
  const columns = board.columns.slice(0, BOARD_COLUMN_RANGE.max)
  const first = columns[0]
  const cards = board.settings.cardsPerPhone
  return (
    <div className="tw-board-phone" aria-label="Phone preview" role="img">
      <p className="tw-board-phone-question">{oneLine(question) || board.question}</p>
      {board.instructions && <p className="tw-board-phone-instructions">{board.instructions}</p>}
      {board.example && <p className="tw-board-phone-example"><small>Example</small> {board.example}</p>}
      <div className="tw-board-phone-tabs">
        {columns.map((column, index) => (
          <span key={`${column.label}:${index}`} className={index === 0 ? 'is-current' : undefined}>{column.label}</span>
        ))}
      </div>
      <div className="tw-board-phone-box">
        <span>{first?.hint || (first ? `Add a card to ${first.label}` : 'Add a card')}</span>
        <small>0/{board.settings.cardChars}</small>
      </div>
      <p className="tw-board-phone-meta">
        {first ? `Your card goes to ${first.label}. ` : ''}
        {board.settings.names ? 'You may add a name; only the speaker sees it.' : 'No name is shown.'}
      </p>
      <p className="tw-board-phone-empty">No cards yet. Yours will be the first.</p>
      <p className="tw-board-phone-meta">Up to {cards} card{cards === 1 ? '' : 's'} each.</p>
    </div>
  )
}
