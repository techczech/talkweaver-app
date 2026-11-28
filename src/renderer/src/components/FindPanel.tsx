import { useEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import { Search } from 'lucide-react'
import type { ProjectionRow } from '../../../preload'
import { headingLevelOfSource, isEmptyQuery, parseQuery } from '../../../shared/slide-handling/query'
import { liveShortcutLabel } from '../keymap/store'
import { usePictureText } from '../lib/slideSearch'
import { runSearch } from '../lib/slideSearchModel'
import { plainInlineText } from '../../../../compiler/scripts/lib/00-inline-render.mjs'
import ImageDrawer from './ImageDrawer'
import type { DrawerTab } from './imageDrawerModel'
import PlainIconPicker from './PlainIconPicker'

const MODES = [
  { id: 'images', label: 'Images', shortcut: 'app.image-search' },
  { id: 'slides', label: 'Slides', shortcut: 'app.find-slides' },
  { id: 'icons', label: 'Icons', shortcut: 'app.find-icons' }
] as const

export type FindMode = typeof MODES[number]['id']

export default function FindPanel({ mode, onMode, onClose, images, slides, onPickIcon }: {
  mode: FindMode
  onMode: (mode: FindMode) => void
  onClose: () => void
  images: Omit<ComponentProps<typeof ImageDrawer>, 'onClose' | 'search'>
  slides: Omit<ComponentProps<typeof FindSlides>, 'query' | 'onQueryChange'>
  onPickIcon: (key: string) => void
}) {
  const [imageQuery, setImageQuery] = useState('')
  const [imageTab, setImageTab] = useState<DrawerTab>('images')
  const [slideQuery, setSlideQuery] = useState('')
  const [iconQuery, setIconQuery] = useState('')
  const shortcut = liveShortcutLabel(MODES.find(item => item.id === mode)!.shortcut)
  return (
    <aside className="find-panel" aria-label="Find" data-find-panel={mode} onKeyDown={event => {
      if (event.key !== 'Escape' || event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      event.stopPropagation()
      event.preventDefault()
      onClose()
    }}>
      <div className="find-panel__head">
        <b>Find</b>
        {shortcut !== 'no shortcut' && <kbd>{shortcut}</kbd>}
      </div>
      <div className="find-panel__modes" role="group" aria-label="Find mode">
        {MODES.map(item => (
          <button key={item.id} type="button" aria-pressed={mode === item.id} onClick={() => onMode(item.id)}>{item.label}</button>
        ))}
      </div>
      {mode === 'images' && <ImageDrawer {...images} onClose={onClose}
        search={{ query: imageQuery, tab: imageTab, onQueryChange: setImageQuery, onTabChange: setImageTab }} />}
      {mode === 'slides' && <FindSlides {...slides} query={slideQuery} onQueryChange={setSlideQuery} />}
      {mode === 'icons' && <PlainIconPicker current={null} onPick={onPickIcon} onClose={onClose}
        search={{ query: iconQuery, onQueryChange: setIconQuery }} />}
    </aside>
  )
}

function FindSlides({ talkPath, talkTitle, rows, thumbnails, onSelect, query, onQueryChange }: {
  talkPath: string
  talkTitle: string
  rows: readonly ProjectionRow[] | null
  thumbnails: Record<string, string> | null
  onSelect: (index: number) => void
  query: string
  onQueryChange: (query: string) => void
}) {
  const [active, setActive] = useState(0)
  const list = useRef<HTMLUListElement>(null)
  const blocks = useMemo(() => (rows ?? []).map(row => row.source_markdown ?? ''), [rows])
  const pictureText = usePictureText(talkPath, blocks, !isEmptyQuery(parseQuery(query)))
  const run = useMemo(() => runSearch((rows ?? []).map((row, index) => ({
    key: index,
    title: `${row.nav_title || ''}\n${row.title || ''}`,
    level: row.role === 'section-title' ? 2 : headingLevelOfSource(blocks[index]),
    body: blocks[index],
    image: pictureText.length === blocks.length ? pictureText[index] : '',
    widget: row.widget_titles?.join('\n')
  })), query, talkTitle), [rows, blocks, pictureText, query, talkTitle])
  const selected = Math.min(active, run.order.length - 1)
  useEffect(() => {
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selected, run])

  return (
    <>
      <label className="image-drawer__search">
        <Search size={17} aria-hidden="true" />
        <input type="search" autoFocus value={query} aria-label="Search slides in this talk" placeholder="Search slides in this talk" spellCheck={false}
          onChange={event => { onQueryChange(event.target.value); setActive(0) }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || selected < 0) return
            if (event.key === 'Enter') onSelect(run.order[selected])
            else if (event.key === 'ArrowDown') setActive(Math.min(selected + 1, run.order.length - 1))
            else if (event.key === 'ArrowUp') setActive(Math.max(selected - 1, 0))
            else return
            event.preventDefault()
          }} />
      </label>
      {run.active && run.order.length === 0 && (
        <p className="find-panel__message" role="status">{rows ? 'No matching slides.' : 'Waiting for slides…'}</p>
      )}
      {rows && run.order.length > 0 && (
        <ul className="find-panel__results" ref={list} aria-label="Matching slides">
          {run.order.map((index, position) => {
            const row = rows[index]
            const thumb = thumbnails?.[row.render_hash || row.content_hash || row.slide_id]
            const title = plainInlineText(row.nav_title || row.title) || `Slide ${index + 1}`
            return (
              <li key={index}>
                <button type="button" data-active={position === selected} onClick={() => { setActive(position); onSelect(index) }}>
                  <span className="find-panel__thumb" aria-hidden="true">
                    {thumb ? <img src={thumb} alt="" loading="lazy" /> : index + 1}
                  </span>
                  <span>{title}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}
