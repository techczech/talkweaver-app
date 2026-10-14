// The ⌘/ keyboard sheet (onboarding 0.38.1 ticket 04). It opens on Here (the commands at the current
// place, the same list Actions here shows), then the ten task groups with their counts and, when one
// is chosen, its sub-groups; a filter searches every command. The data is generated from the
// registries (shared/keyboard-sheet.ts); the sheet types no command.
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Eye, FolderOpen, LayoutTemplate, Library, MapPin, PenLine, Play, Presentation, Search, Share2,
  SlidersHorizontal, Stethoscope, Waypoints, X
} from 'lucide-react'
import { listedPaletteCommands } from '../../../shared/command-registry'
import { shortcutById } from '../../../shared/shortcut-registry'
import { TASK_GROUPS, type TaskGroup } from '../../../shared/task-groups'
import { keyboardSheet, searchSheet, type SheetRow } from '../../../shared/keyboard-sheet'
import type { Place, PlaceRow } from '../../../shared/place'
import type { VaultState } from '../../../shared/actions-here'
import { liveShortcutLabel, onKeymapChanged } from '../keymap/store'

interface Props {
  isOpen: boolean
  onClose: () => void
  /** Where the caret or the selected row is; null with no talk open (the sheet has no Here then). */
  place?: Place | null
  placeRow?: PlaceRow
  /** The slide at the caret is a quote slide: Here then lists the Quote form rows, like Actions here. */
  quoteSlide?: boolean
  vault?: VaultState
  /** Run a row from the sheet (the shared route); the sheet closes first. */
  onRun?: (row: SheetRow) => void
  /** Can a carried row (Explain rendering, Present from here) be run from the sheet? */
  canRunCarried?: (key: string) => boolean
}

const GROUP_ICONS: Readonly<Record<TaskGroup, JSX.Element>> = {
  'Write the outline': <PenLine size={14} />,
  'Build a slide': <LayoutTemplate size={14} />,
  'Reuse slides': <Library size={14} />,
  'See the talk': <Eye size={14} />,
  'Shape the talk': <Waypoints size={14} />,
  Present: <Presentation size={14} />,
  Share: <Share2 size={14} />,
  'Manage talks': <FolderOpen size={14} />,
  'Check and repair': <Stethoscope size={14} />,
  'Set up TalkWeaver': <SlidersHorizontal size={14} />
}

type Section = { kind: 'here' } | { kind: 'group'; taskGroup: TaskGroup; sub: string | null } | { kind: 'surface'; surface: string }

function defaultChordOf(shortcutId: string): string {
  const shortcut = shortcutById(shortcutId)
  return shortcut.unbound ? 'no default' : shortcut.keys
}

function RowView({ row, onRun }: { row: SheetRow; onRun: (row: SheetRow) => void }) {
  return (
    <div className="kbd-sheet-row" data-sheet-row={row.key}>
      <span className="kbd-sheet-label">{row.label}</span>
      {row.was && <span className="kbd-sheet-was" data-sheet-rebound>rebound · was {row.was}</span>}
      {row.chord === 'no key'
        ? <span className="kbd-sheet-nokey">no key</span>
        : <kbd className="kbd-sheet-chord">{row.chord}</kbd>}
      {row.run && (
        <button type="button" className="kbd-sheet-run" data-sheet-run={row.key} onClick={() => onRun(row)} title={`Run ${row.label}`}>
          <Play size={11} aria-hidden="true" />Run
        </button>
      )}
    </div>
  )
}

export default function KeyboardHelp({ isOpen, onClose, place = null, placeRow = null, quoteSlide = false, vault, onRun, canRunCarried }: Props) {
  const [revision, setRevision] = useState(0)
  useEffect(() => onKeymapChanged(() => setRevision((value) => value + 1)), [])
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const runnable = useMemo(() => new Set(listedPaletteCommands().map((command) => command.id)), [])
  const data = useMemo(
    () => keyboardSheet({
      place,
      context: { row: placeRow, vault, quoteSlide },
      chordOf: liveShortcutLabel,
      defaultChordOf,
      canRun: (id) => runnable.has(id),
      canRunCarried
    }),
    // revision: a rebound chord redraws the sheet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [place, placeRow, quoteSlide, vault, revision, runnable, canRunCarried]
  )

  const [section, setSection] = useState<Section>(() =>
    data.opensOn === 'here' ? { kind: 'here' } : { kind: 'group', taskGroup: data.opensOn, sub: null })

  // Opening resets the query and puts the sheet on Here, or on the first task group with no talk
  // open. Done while rendering, so the first frame already shows it (no frame of the last query).
  const [wasOpen, setWasOpen] = useState(isOpen)
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen)
    if (isOpen) {
      setQuery('')
      setSection(data.opensOn === 'here' ? { kind: 'here' } : { kind: 'group', taskGroup: data.opensOn, sub: null })
    }
  }
  useEffect(() => {
    if (isOpen) requestAnimationFrame(() => inputRef.current?.focus())
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    // Close on Escape (and on a second Ctrl-/ — handled by the global toggle). NOT on "?",
    // because this popup can be opened WHILE typing in the editor, where "?" is a real character.
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKey, { capture: true })
    return () => window.removeEventListener('keydown', handleKey, { capture: true })
  }, [isOpen, onClose])

  if (!isOpen) return null

  const searching = query.trim().length > 0
  const results = searching ? searchSheet(data, query) : []
  const run = (row: SheetRow): void => { onClose(); onRun?.(row) }

  // The right-hand pane: search results, Here, a task group, or a surface's keys.
  let heading = ''
  let body: JSX.Element
  if (searching) {
    heading = `${results.length} ${results.length === 1 ? 'command matches' : 'commands match'}`
    body = results.length === 0
      ? <div className="kbd-sheet-empty" data-sheet-empty>{`No command matches “${query.trim()}”`}</div>
      : <>{results.map((row) => <RowView key={`${row.taskGroup}:${row.key}`} row={row} onRun={run} />)}</>
  } else if (section.kind === 'here' && data.here) {
    heading = data.here.heading
    body = <>{withHeadings(data.here.rows, (row) => row.taskGroup ?? '').map((part) => part.heading
      ? <div key={`h:${part.heading}`} className="kbd-sheet-heading" role="presentation">{part.heading}</div>
      : <RowView key={part.row!.key} row={part.row!} onRun={run} />)}</>
  } else if (section.kind === 'surface') {
    const surface = data.surfaces.find((candidate) => candidate.surface === section.surface)
    heading = section.surface
    body = <>{(surface?.rows ?? []).map((row) => <RowView key={row.key} row={row} onRun={run} />)}</>
  } else {
    const taskGroup = section.kind === 'group' ? section.taskGroup : TASK_GROUPS[0]
    const sub = section.kind === 'group' ? section.sub : null
    const group = data.groups.find((candidate) => candidate.taskGroup === taskGroup)!
    heading = taskGroup
    const rows = sub ? group.rows.filter((row) => row.subgroup === sub) : group.rows
    body = <>{withHeadings(rows, (row) => row.subgroup ?? '').map((part) => part.heading
      ? <div key={`h:${part.heading}`} className="kbd-sheet-heading" role="presentation">{part.heading}</div>
      : <RowView key={part.row!.key} row={part.row!} onRun={run} />)}</>
  }

  const isHere = !searching && section.kind === 'here'
  return (
    <>
      <div className="kbd-sheet-backdrop" onClick={onClose} />
      <div className="kbd-sheet" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" data-keyboard-sheet>
        <div className="kbd-sheet-top">
          <span className="kbd-sheet-title">Keyboard shortcuts</span>
          <label className="kbd-sheet-filter">
            <Search size={14} aria-hidden="true" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              placeholder="Filter all commands"
              aria-label="Filter all commands"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <button type="button" className="kbd-sheet-close" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="kbd-sheet-body">
          <nav className="kbd-sheet-nav" aria-label="Sections">
            {data.here && (
              <button
                type="button"
                className={`kbd-sheet-item kbd-sheet-item--here${section.kind === 'here' && !searching ? ' kbd-sheet-item--on' : ''}`}
                data-sheet-section="here"
                onClick={() => { setQuery(''); setSection({ kind: 'here' }) }}
              >
                <MapPin size={14} aria-hidden="true" /><span className="kbd-sheet-item-label">{data.here.heading}</span>
                <span className="kbd-sheet-count" data-sheet-count="here">{data.here.count}</span>
              </button>
            )}
            {data.here && <hr className="kbd-sheet-rule" />}
            {data.groups.map((group) => {
              const on = section.kind === 'group' && section.taskGroup === group.taskGroup && !searching
              return (
                <div key={group.taskGroup}>
                  <button
                    type="button"
                    className={`kbd-sheet-item${on ? ' kbd-sheet-item--on' : ''}`}
                    data-sheet-section={group.taskGroup}
                    onClick={() => { setQuery(''); setSection({ kind: 'group', taskGroup: group.taskGroup, sub: null }) }}
                  >
                    {GROUP_ICONS[group.taskGroup]}<span className="kbd-sheet-item-label">{group.taskGroup}</span>
                    <span className="kbd-sheet-count" data-sheet-count={group.taskGroup}>{group.count}</span>
                  </button>
                  {on && group.subgroups.map((sub) => (
                    <button
                      key={sub.name}
                      type="button"
                      className={`kbd-sheet-sub${section.kind === 'group' && section.sub === sub.name ? ' kbd-sheet-sub--on' : ''}`}
                      data-sheet-subgroup={sub.name}
                      onClick={() => setSection({ kind: 'group', taskGroup: group.taskGroup, sub: section.kind === 'group' && section.sub === sub.name ? null : sub.name })}
                    >
                      <span className="kbd-sheet-item-label">{sub.name}</span><span className="kbd-sheet-count">{sub.count}</span>
                    </button>
                  ))}
                </div>
              )
            })}
            {data.surfaces.length > 0 && <hr className="kbd-sheet-rule" />}
            {data.surfaces.map((surface) => (
              <button
                key={surface.surface}
                type="button"
                className={`kbd-sheet-item kbd-sheet-item--surface${section.kind === 'surface' && section.surface === surface.surface && !searching ? ' kbd-sheet-item--on' : ''}`}
                data-sheet-section={`surface:${surface.surface}`}
                onClick={() => { setQuery(''); setSection({ kind: 'surface', surface: surface.surface }) }}
              >
                <span className="kbd-sheet-item-label">{surface.surface} keys</span>
                <span className="kbd-sheet-count">{surface.rows.length}</span>
              </button>
            ))}
          </nav>
          <div className="kbd-sheet-pane" data-sheet-pane={isHere ? 'here' : searching ? 'search' : 'section'}>
            <h2 className="kbd-sheet-pane-title">{heading}</h2>
            {body}
          </div>
        </div>
        <div className="kbd-sheet-foot">
          <kbd>⌃</kbd><kbd>/</kbd> to open anywhere · <kbd>Esc</kbd> to close
        </div>
      </div>
    </>
  )
}

/** The rows with a heading wherever the label changes, in row order. */
function withHeadings(rows: readonly SheetRow[], label: (row: SheetRow) => string): Array<{ heading: string | null; row: SheetRow | null }> {
  const parts: Array<{ heading: string | null; row: SheetRow | null }> = []
  let last: string | null = null
  for (const row of rows) {
    const name = label(row)
    if (name && name !== last) { parts.push({ heading: name, row: null }); last = name }
    parts.push({ heading: null, row })
  }
  return parts
}
