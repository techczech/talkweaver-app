// "Find a talk" — the slide picker's talk box above "Search slides" (ADR-0029 §4; ticket
// talk-search 05; frames K1–K4). It is the file list's talk search: the same query language,
// hint row, completion, results and match lines, through the same renderer call (useTalkSearch).
// ↵ on a result scopes the picker to that talk and the box shows it as a removable chip; ⌘↵
// (slide-picker.add-beside, rebindable) adds it beside as a further column; the slide search is
// never touched. Scope moves and key
// ownership are pure functions in findTalkModel.ts.
import { useEffect, useMemo, useRef, useState } from 'react'
import { FileText, MonitorPlay, Search, X } from 'lucide-react'
import type { TalkInfo } from '../../../../preload/index'
import { readingLine } from '../../../../shared/talk-search'
import { CompletionPop, PrefixHints, useSearchAssist } from '../talklist/SearchAssist'
import { Marked, SearchLine } from '../talklist/SearchLine'
import { noResultSuggestions } from '../talklist/prefixAssist'
import { useTalkSearch } from '../talklist/useTalkSearch'
import { type FindTalkRow, findBoxOwnsKey, findTalkRows, firstPickable, talkEntry } from './findTalkModel'
import { type ScopeEntry, scopeKeyOf } from './railModel'
import { liveShortcutLabel } from '../../keymap/store'
import { isTypingKey, surfaceKey } from '../../keymap/surfaceKeys'
import type { FindTalkCommands } from '../slidePickerCommands'

export interface FindTalkProps {
  query: string
  onQueryChange: (query: string) => void
  /** The vault's talks (the file list's own list): result rows use these, as the file list does. */
  talks: TalkInfo[]
  currentTalkSlug: string
  slidesOf: (slug: string) => number
  /** The talks picked from this box that are still in the scope. */
  chips: ScopeEntry[]
  onPick: (entry: ScopeEntry) => void
  onAddBeside: (entry: ScopeEntry) => void
  onRemoveChip: (key: string) => void
  /** Filled with the box's focus and its add-beside, for the picker's palette commands. */
  commandRef?: { current: FindTalkCommands | null }
}

export default function FindTalk(props: FindTalkProps) {
  const { query, onQueryChange, talks, currentTalkSlug } = props
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const assist = useSearchAssist({ query, setQuery: onQueryChange, searchRef: inputRef, talksVersion: talks })
  const { searching, result, settled } = useTalkSearch({ query, talksVersion: talks })
  const listed = useMemo(() => new Map(talks.map((t) => [t.outlinePath, t])), [talks])
  const rows = useMemo(
    () => (searching && result ? findTalkRows(result.hits, listed, currentTalkSlug) : []),
    [searching, result, listed, currentTalkSlug]
  )
  const suggestions = useMemo(
    () => (searching && settled && result && result.hits.length === 0 ? noResultSuggestions(query, assist.folders) : []),
    [searching, settled, result, query, assist.folders]
  )
  const [active, setActive] = useState(0)
  const rowsKey = rows.map((r) => r.key).join('|')
  useEffect(() => { setActive(firstPickable(rows)) }, [rowsKey]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-find-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const listing = rows.length > 0
  const completing = !!assist.completion

  function choose(row: FindTalkRow | undefined, beside: boolean): void {
    if (!row || row.current) return
    const entry = talkEntry(row.talk)
    onQueryChange('')
    if (beside) { props.onAddBeside(entry); return }
    props.onPick(entry)
    // Picked: the talk's slides are what comes next, so the grid keys take over (Space, X, ↵).
    inputRef.current?.blur()
  }

  const activeRow = (): FindTalkRow | undefined => rows[Math.min(active, rows.length - 1)]
  // The palette's "Add the highlighted talk beside" runs this; so does the add-beside key below.
  function addActiveBeside(): true | string {
    const row = activeRow()
    if (!row) return 'Find a talk lists no talks — type a talk’s name in it first.'
    if (row.current) return 'That is the talk you are editing; its slides are not in the picker.'
    choose(row, true)
    return true
  }
  if (props.commandRef) props.commandRef.current = { focus: () => inputRef.current?.focus(), addActiveBeside }
  const commandRef = props.commandRef
  useEffect(() => () => { if (commandRef) commandRef.current = null }, [commandRef])

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (assist.onKeyDown(e)) return
    if (e.key === 'Backspace' && query === '' && props.chips.length > 0) {
      e.preventDefault()
      props.onRemoveChip(scopeKeyOf(props.chips[props.chips.length - 1]))
      return
    }
    // Add beside (⌘↵ by default, rebindable): the highlighted talk as a further column. A plain
    // letter rebind is typing here, so it never fires in the box.
    if (listing && !isTypingKey(e.nativeEvent) && surfaceKey(e.nativeEvent, 'add-beside')) {
      e.preventDefault()
      e.stopPropagation()
      choose(activeRow(), true)
      return
    }
    if (!findBoxOwnsKey(e.key, { value: query, listing, completing })) return
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') { onQueryChange(''); return }
    if (e.key === 'ArrowDown') { setActive((a) => Math.min(rows.length - 1, a + 1)); return }
    if (e.key === 'ArrowUp') { setActive((a) => Math.max(0, a - 1)); return }
    if (e.key === 'Enter') choose(activeRow(), false)
  }
  const addBesideKeys = liveShortcutLabel('slide-picker.add-beside')

  const reading = searching && result ? readingLine(result) : null

  return (
    <div className="lt-find">
      <div className="lt-rghead static"><MonitorPlay className="lt-icon" /> Find a talk</div>
      <div className={`lt-findfield${props.chips.length > 0 ? ' has-chips' : ''}`} onMouseDown={(e) => {
        // A click on the box's padding (not a chip) puts the caret in the input.
        if (e.target === e.currentTarget) { e.preventDefault(); inputRef.current?.focus() }
      }}>
        <Search className="lt-icon" />
        {props.chips.map((c) => {
          const key = scopeKeyOf(c)
          const name = c.talkTitle || c.talk || ''
          return (
            <span key={key} className="lt-find-chip" data-chip-talk={c.talk} title={name}>
              <MonitorPlay className="lt-icon" />
              <span className="lt-find-chip-nm">{name}</span>
              <button
                type="button"
                className="lt-find-chip-x"
                aria-label={`Remove ${name} from the scope`}
                title="Remove from the scope"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => props.onRemoveChip(key)}
              >
                <X className="lt-icon" />
              </button>
            </span>
          )
        })}
        <input
          ref={inputRef}
          type="text"
          value={query}
          data-find-talk="1"
          data-listing={listing ? '1' : '0'}
          data-completing={completing ? '1' : '0'}
          placeholder={props.chips.length > 0 ? '' : 'Name, folder, event, date…'}
          autoComplete="off"
          spellCheck={false}
          aria-label="Find a talk — plain words, or fo: folder · fi: file name · met: details · co: slides · da: date"
          onChange={(e) => assist.onChange(e.target.value, e.target.selectionStart)}
          onFocus={assist.onFocus}
          onBlur={assist.onBlur}
          onSelect={(e) => assist.onSelect(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
        />
      </div>
      {assist.completion
        ? <CompletionPop completion={assist.completion} active={assist.active} onPick={assist.pick} onHover={assist.setActive} />
        : assist.hintVisible && props.chips.length === 0 ? <PrefixHints onPick={assist.pickHint} /> : null}

      {searching && (
        <div className="lt-find-results" role="listbox" aria-label="Talks" data-answered={settled ? query : undefined}>
          {reading && <div className="lt-find-note" role="status">{reading}</div>}
          {listing && (
            <>
              <div className="lt-find-head">{rows.length} {rows.length === 1 ? 'talk' : 'talks'}</div>
              <div className="lt-find-list" ref={listRef}>
                {rows.map((r, i) => (
                  <button
                    key={r.key}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={i === active}
                    data-find-index={i}
                    data-talk-slug={r.talk.slug}
                    className={`lt-find-row${i === active ? ' on' : ''}${r.current ? ' current' : ''}`}
                    title={r.current
                      ? 'The talk you are editing — its slides live in the grid/strip, not the Browser'
                      : `Show this talk (↵) · add it beside (${addBesideKeys} or ⌘click)`}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseMove={() => { if (i !== active) setActive(i) }}
                    onClick={(e) => choose(r, e.metaKey || e.ctrlKey)}
                  >
                    <FileText className="lt-icon lt-ficon" />
                    <span className="lt-find-text">
                      <span className="lt-find-name"><Marked text={r.talk.title} ranges={r.hit.titleHighlights} /></span>
                      <SearchLine hit={r.hit} focusPath="" />
                    </span>
                    {r.current && <span className="lt-current-tag">current</span>}
                    {i === active && !r.current && <span className="lt-find-beside">{addBesideKeys} add beside</span>}
                    <span className="lt-tc">{props.slidesOf(r.talk.slug)}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          {!listing && settled && (
            <div className="lt-find-empty">
              <p>No talks match <b>“{query}”</b>.</p>
              {suggestions.map((s) => (
                <p key={s.key} data-suggestion={s.kind}>
                  {s.kind === 'folder' ? (
                    <>Did you mean folder <button type="button" className="lt-find-sugg" onClick={() => assist.replaceQuery(s.query)}>{s.name}</button>? · {s.count} {s.count === 1 ? 'talk' : 'talks'}</>
                  ) : (
                    <button type="button" className="lt-find-sugg" onClick={() => assist.replaceQuery(s.query)}>{s.label}</button>
                  )}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
