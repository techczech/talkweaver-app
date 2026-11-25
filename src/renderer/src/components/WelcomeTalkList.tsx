import { useLayoutEffect, useMemo, useState, type KeyboardEvent, type RefObject } from 'react'
import { ChevronDown, ChevronUp, GraduationCap, Library, Search, X } from 'lucide-react'
import type { TalkInfo, VaultView } from '../../../preload/index'
import { readingLine, type TalkSearchHit } from '../../../shared/talk-search'
import { talkTitleText } from '../../../shared/talk-title-text'
import { COMMAND_REGISTRY } from '../../../shared/command-registry'
import { effectiveKeys, liveCommandShortcutLabel, onKeymapChanged } from '../keymap/store'
import { useTalkFacts } from '../lib/talkFacts'
import { topicOf } from './talkTreeNav'
import { isIgnoredPath } from './talklist/model'
import { Marked } from './talklist/SearchLine'
import { useTalkSearch } from './talklist/useTalkSearch'

interface Props {
  talks: TalkInfo[]
  vaults: VaultView[]
  searchRef: RefObject<HTMLInputElement>
  busy: boolean
  onOpen: (talk: TalkInfo) => void
  onUseName: (name: string) => void
  onOpenTalks: () => void
  onExamples: () => void
}

type SortColumn = 'edited' | 'slides'
type Sort = { column: SortColumn; ascending: boolean }
const DEFAULT_SORT: Sort = { column: 'edited', ascending: false }
const searchCommand = COMMAND_REGISTRY.find(command => command.id === 'search-talks')!
const searchChord = (): string => effectiveKeys(searchCommand.shortcutId!) ? liveCommandShortcutLabel(searchCommand) : ''

function editedDate(ms: number): string {
  if (!ms) return '—'
  const date = new Date(ms)
  const year = date.getFullYear()
  return date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '')
    + (year === new Date().getFullYear() ? '' : ` ${year}`)
}

export default function WelcomeTalkList({ talks, vaults, searchRef, busy, onOpen, onUseName, onOpenTalks, onExamples }: Props) {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState(DEFAULT_SORT)
  const [selected, setSelected] = useState<string | null>(null)
  const [chord, setChord] = useState(searchChord)
  const { meta } = useTalkFacts()
  const vaultIds = useMemo(() => vaults.filter(vault => vault.open && !vault.unavailable).map(vault => vault.id), [vaults])
  const { searching, result, settled } = useTalkSearch({ query, vaultIds, talksVersion: talks })
  const byPath = useMemo(() => new Map(talks.map(talk => [talk.outlinePath, talk])), [talks])

  const recent = useMemo(() => {
    const roots = new Map(vaults.map(vault => [vault.id, vault.root]))
    return talks.filter(talk => {
      const root = talk.vaultId ? roots.get(talk.vaultId) : undefined
      return root && !isIgnoredPath(topicOf(talk, root)) && meta[talk.outlinePath]?.editedMs > 0
    }).sort((a, b) => meta[b.outlinePath].editedMs - meta[a.outlinePath].editedMs).slice(0, 8)
  }, [talks, vaults, meta])

  const rows = useMemo(() => {
    const withFacts = (talk: TalkInfo, hit?: TalkSearchHit) => ({
      talk, hit, slides: meta[talk.outlinePath]?.slideCount ?? null,
      edited: hit?.editedMs || meta[talk.outlinePath]?.editedMs || 0
    })
    const entries = searching ? (settled ? result?.hits ?? [] : []).flatMap(hit => {
      const talk = byPath.get(hit.outlinePath)
      return talk ? [withFacts(talk, hit)] : []
    }) : recent.map(talk => withFacts(talk))
    return entries.sort((a, b) => {
      if (sort.column === 'slides') {
        if (a.slides === null && b.slides !== null) return 1
        if (a.slides !== null && b.slides === null) return -1
        const difference = (a.slides ?? 0) - (b.slides ?? 0)
        if (difference) return sort.ascending ? difference : -difference
      }
      return sort.column === 'edited' && sort.ascending ? a.edited - b.edited : b.edited - a.edited
    })
  }, [searching, settled, result, byPath, recent, meta, sort])

  const selectedIndex = rows.findIndex(row => row.talk.outlinePath === selected)
  const activeIndex = selectedIndex < 0 && searching && rows.length ? 0 : selectedIndex
  const rowId = (index: number): string => `tw-welcome-talk-${index}`
  const reading = settled && result ? readingLine(result) : null

  useLayoutEffect(() => onKeymapChanged(() => setChord(searchChord())), [])
  useLayoutEffect(() => {
    if (selected && activeIndex >= 0) document.getElementById(rowId(activeIndex))?.scrollIntoView({ block: 'nearest' })
  }, [selected, activeIndex])

  function changeQuery(value: string): void {
    setQuery(value)
    setSort(DEFAULT_SORT)
    setSelected(null)
  }
  function clearSearch(): void {
    changeQuery('')
    searchRef.current?.focus()
  }
  function handleKey(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (event.key === 'Escape' && query) {
      event.preventDefault()
      event.stopPropagation()
      clearSearch()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!rows.length) return
      event.preventDefault()
      const next = activeIndex < 0 && event.key === 'ArrowUp' ? rows.length - 1
        : Math.max(0, Math.min(rows.length - 1, activeIndex + (event.key === 'ArrowDown' ? 1 : -1)))
      setSelected(rows[next].talk.outlinePath)
    } else if (event.key === 'Enter' && rows.length) {
      event.preventDefault()
      if (!busy) onOpen(rows[Math.max(0, activeIndex)].talk)
    }
  }
  function sortBy(column: SortColumn): void {
    setSort({ column, ascending: sort.column === column && !sort.ascending })
    setSelected(null)
  }
  const sortHeader = (column: SortColumn, label: string): JSX.Element => (
    <th scope="col" aria-sort={sort.column !== column ? 'none' : sort.ascending ? 'ascending' : 'descending'}>
      <button type="button" onClick={() => sortBy(column)}>
        {label}{sort.column === column && (sort.ascending ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
      </button>
    </th>
  )

  return (
    <section className="tw-welcome-open" aria-labelledby="tw-welcome-open-heading">
      <div className="tw-welcome-open-inner">
        <h2 id="tw-welcome-open-heading">Open a talk</h2>
        <div className="tw-welcome-search">
          <Search size={16} aria-hidden />
          <input ref={searchRef} autoFocus value={query} placeholder="Search all your talks" aria-label="Search all your talks"
            role="combobox" aria-autocomplete="list" aria-haspopup="grid" aria-expanded={rows.length > 0}
            aria-controls={rows.length ? 'tw-welcome-talks' : undefined}
            aria-activedescendant={activeIndex >= 0 ? rowId(activeIndex) : undefined}
            onChange={event => changeQuery(event.currentTarget.value)} onKeyDown={handleKey} />
          {query ? <button type="button" className="icon-btn" title="Clear search" aria-label="Clear search" onClick={clearSearch}><X size={15} /></button>
            : chord && <kbd>{chord}</kbd>}
        </div>
        {!searching || rows.length > 0 ? (
          <>
            <div className="tw-welcome-list">
              <table id="tw-welcome-talks" role="grid" aria-label={searching ? 'Search results' : 'Recent talks'}>
                <colgroup><col /><col className="tw-welcome-slide-count" /><col className="tw-welcome-edited" /></colgroup>
                <thead><tr>
                  <th scope="col"><span role="status">{searching ? `${rows.length} ${rows.length === 1 ? 'talk matches' : 'talks match'} “${query.trim()}”` : 'Recent talks'}</span></th>
                  {sortHeader('slides', 'Slides')}{sortHeader('edited', 'Last edited')}
                </tr></thead>
                <tbody>
                  {rows.map(({ talk, hit, slides, edited }, index) => {
                    const title = hit?.title ?? talkTitleText(talk.title)
                    return (
                      <tr key={talk.outlinePath} id={rowId(index)} aria-selected={index === activeIndex}
                        title={title} onClick={() => { if (!busy) onOpen(talk) }}>
                        <td><div className="tw-welcome-row-name">
                          <button type="button" disabled={busy}
                            onClick={event => { event.stopPropagation(); onOpen(talk) }}>
                            <Marked text={title} ranges={hit?.titleHighlights ?? []} />
                          </button>
                          {hit && <span className="tw-welcome-row-folder" title={hit.folder || 'Vault root'}>{hit.folder || 'Vault root'}</span>}
                          {searching && index === activeIndex && <kbd aria-hidden>↵ Open</kbd>}
                        </div></td>
                        <td>{slides ?? '—'}</td><td>{editedDate(edited)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {!searching && <div className="tw-welcome-list-actions">
              <button type="button" className="tw-welcome-button tw-welcome-button--small" onClick={onOpenTalks}>
                <Library size={14} />Show all {talks.length} {talks.length === 1 ? 'talk' : 'talks'}
              </button>
              <button type="button" className="tw-welcome-button tw-welcome-button--small" disabled={busy} onClick={onExamples}>
                <GraduationCap size={14} />Example talks
              </button>
            </div>}
          </>
        ) : settled && !reading ? (
          <div className="tw-welcome-no-match">
            <strong role="status">No talk matches “{query.trim()}”.</strong>
            <p>Check the spelling, or start a new talk with this name.</p>
            <div>
              <button type="button" className="tw-welcome-button" disabled={busy} onClick={() => onUseName(query)}>Name a new talk “{query.trim()}”</button>
              <button type="button" className="tw-welcome-button" onClick={clearSearch}>Clear search</button>
            </div>
          </div>
        ) : null}
        {reading && <div className="tw-welcome-reading" role="status">{reading}</div>}
      </div>
    </section>
  )
}
