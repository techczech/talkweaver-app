import { Fragment, type MouseEvent } from 'react'
import { ChevronRight, Ellipsis, ExternalLink, Folder, Presentation } from 'lucide-react'
import type { TalkMeta } from '../../../../preload'
import { galleryIdentity, type GalleryFacts } from '../../../../shared/vault-gallery'
import { folderTalks, leafName, parentOf, plural, type BrowseView } from '../../../../shared/vault-gallery-browse'
import { plainTalkTitle } from '../../../../shared/plain-title'
import { highlightSegments, parseQuery, snippet, widgetSearchText, type SlideQuery } from '../../../../shared/slide-handling/query'
import { authoredPictureFields, slideBodyForSearchDisplay } from '../../../../shared/slide-handling/image-refs'
import { thumbUrl } from '../../lib/thumbUrl'
import { surfaceKey } from '../../keymap/surfaceKeys'
import { VaultBadge } from '../talklist/VaultRows'
import type { ExplorerPlace, ExplorerResult, ExplorerTalk, ExplorerVault } from './explorerModel'
import type { Known } from './galleryValues'

export const resultKey = ({ talk, slide }: ExplorerResult) => slide
  ? JSON.stringify([galleryIdentity(talk), slide.order, slide.slide_id]) : galleryIdentity(talk)

function Marked({ text, terms }: { text: string; terms: readonly string[] }) {
  return <>{highlightSegments(text, terms).map(({ text, hit }, i) => hit ? <mark key={i}>{text}</mark> : <Fragment key={i}>{text}</Fragment>)}</>
}

function Cover({ facts, title }: { facts?: GalleryFacts; title: string }) {
  return <span className="vx-cover" aria-hidden>{facts?.coverUrl
    ? <img src={facts.coverUrl} alt="" draggable={false} />
    : <><Presentation size={14} /><span>{title}</span></>}</span>
}

export function ExplorerFolderCards({ item, folder, known, onOpen, onMenu }: {
  item: ExplorerVault
  folder: string
  known: Pick<Known, 'facts'>
  onOpen(path: string): void
  onMenu(path: string, event: MouseEvent<HTMLElement>): void
}) {
  const folders = item.folders.filter(path => parentOf(path) === folder)
  if (!folders.length) return null
  return <div className="vx-folder-cards">
    {folders.map(path => {
      const talks = folderTalks(item.talks, path)
      const children = item.folders.filter(f => parentOf(f) === path).length
      const previews = talks.slice(0, 3)
      const name = leafName(path)
      const count = plural(talks.length, 'talk')
      return <button type="button" className="vx-folder-card" key={path} aria-label={`${name}, ${count}`}
        onClick={() => onOpen(path)} onContextMenu={event => onMenu(path, event)}>
        <Folder className="vg-ic-folder" size={22} />
        <span><strong>{name}</strong><small>{count}{children > 0 ? ` · ${plural(children, 'folder')}` : ''}</small></span>
        {!!previews.length && <span className="vx-fan" data-mosaic={JSON.stringify(previews.map(galleryIdentity))}>
          {previews.map(talk => <Cover key={galleryIdentity(talk)} title={talk.title} facts={known.facts[galleryIdentity(talk)]} />)}
        </span>}
      </button>
    })}
  </div>
}

export const vaultLocation = (item: ExplorerVault): string => {
  const { root, service } = item.vault
  const parts = root.split(/[\\/]/).filter(Boolean)
  return `${service === 'Local' ? 'On this Mac' : service} · ${parts.slice(-2).join('/')}`
}

export function TalkLocation({ talk, terms = [] }: { talk: ExplorerTalk; terms?: readonly string[] }) {
  const parts = [talk.vault.name, ...talk.folder.split('/').filter(Boolean)]
  return <span className="vx-talk-location" title={parts.join(' › ')}>
    <VaultBadge vault={talk.vault} size={16} />
    {parts.map((label, i) => <Fragment key={i}>{i > 0 && <ChevronRight size={12} />}<span><Marked text={label} terms={i > 0 ? terms : []} /></span></Fragment>)}
  </span>
}

function dateOf(ms: number | null | undefined): string {
  if (!ms) return '—'
  const date = new Date(ms)
  return date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short',
    year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }).replace(',', '')
}

function slideExcerpt(slide: NonNullable<ExplorerResult['slide']>, title: string, query: SlideQuery) {
  const source = slide.source_markdown ?? ''
  const { names, descriptions } = authoredPictureFields(source)
  const imageNames = names.join('\n')
  const imageDescriptions = [...descriptions, slide.matchEvidence?.resolvedPictureText].filter(Boolean).join('\n')
  const match = snippet({
    title,
    body: slideBodyForSearchDisplay(source),
    image: [imageNames, imageDescriptions].filter(Boolean).join('\n'),
    widget: [slide.widget_titles?.join('\n'), widgetSearchText(source)].filter(Boolean).join('\n')
  }, query)
  if (match?.label === 'in picture') {
    const nameMatches = snippet({ title, body: '', image: imageNames }, query)
    return { match, label: nameMatches ? 'Image name' : 'Image description' }
  }
  if (match?.label === 'in widget' || (!match && slide.matchEvidence?.fields.widget)) return { match, label: 'Widget' }
  return { match, label: match ? 'Text' : slide.matchEvidence?.fields.title || slide.titleHit ? 'Slide title' : '' }
}

export default function ExplorerRows({ rows, group, view, known, meta, terms, active, busy, query, location, slideCounts, onOpen, onMenu }: {
  rows: ExplorerResult[]
  group: string
  view: BrowseView
  known: Pick<Known, 'facts' | 'handouts'>
  meta: TalkMeta
  terms: readonly string[]
  active?: string
  busy: boolean
  query?: string
  location?: ExplorerPlace
  slideCounts?: Map<string, number>
  onOpen(row: ExplorerResult, newWindow: boolean): void
  onMenu(row: ExplorerResult, event: MouseEvent<HTMLElement>): void
}) {
  if (!rows.length) return null
  const slides = rows.some(row => !!row.slide)
  const gallery = view === 'Gallery' && !slides
  const parsed = query && slides ? parseQuery(query, { operators: true, prefixes: false }) : null
  return <div className={`vx-rows ${slides ? 'vx-slide-results' : gallery ? 'vx-tiles' : 'vx-list'}`} role="group" aria-label={group} id={group === 'Search results' ? 'vx-results' : undefined}>
    {!gallery && !slides && <div className="vx-row-head" aria-hidden><span /> <span>Name</span><span>Slides</span><span>Handout</span><span>Last edited</span><span /></div>}
    {rows.map((row, i) => {
      const { talk, slide } = row
      const identity = galleryIdentity(talk)
      const key = resultKey(row)
      const facts = known.facts[identity]
      const handouts = known.handouts[identity]
      const info = meta[talk.info.outlinePath]
      const slideCount = facts?.slideCount ?? info?.slideCount
      const edited = dateOf(facts?.editedMs ?? info?.editedMs ?? talk.cachedEditedMs)
      const title = plainTalkTitle(talk.title)
      const slideTitle = slide ? plainTalkTitle(slide.nav_title || slide.title || 'Untitled slide') : ''
      const slideNumber = slide ? `Slide ${slide.order + 1}` : ''
      const label = slide ? `${title} — ${slideNumber}: ${slideTitle}` : title
      const excerpt = slide && parsed ? slideExcerpt(slide, slideTitle, parsed) : null
      const match = excerpt?.match
      const showLocation = !gallery || location?.vaultId !== talk.vaultId || location?.folder !== talk.folder
      const blocked = !!talk.vault.unavailable
      return <Fragment key={key}>
        {slide && rows[i - 1]?.talk !== talk && <div className="vx-slide-group" data-identity={identity}>
          <Cover facts={facts} title={title} /><strong>{title}</strong><TalkLocation talk={talk} />
          <small>{plural(slideCounts?.get(talk.info.outlinePath) ?? 0, 'slide')}</small>
        </div>}
        <div className={`vx-row${key === active ? ' vx-row-active' : ''}${blocked ? ' vx-row-unavailable' : ''}`}
          data-identity={slide || blocked ? undefined : identity} id={group === 'Search results' ? `vx-result-${i}` : undefined}
          onContextMenu={event => { if (!blocked) onMenu(row, event) }}>
          <button type="button" className="vx-talk-open" disabled={busy || blocked} aria-label={label} title={label}
            onClick={event => onOpen(row, event.metaKey || event.ctrlKey)} onKeyDown={event => {
              // SCAN_IGNORE: modified activation of the focused talk or slide result.
              if (surfaceKey(event.nativeEvent, 'vault-explorer.open-window')) {
                event.preventDefault(); event.stopPropagation(); onOpen(row, true)
              }
            }}>
            {slide ? <>
              <span className="vx-cover"><Presentation size={17} /><img loading="lazy" src={thumbUrl(slide.talkSlug, slide.render_hash || slide.content_hash, slide.vaultId)} alt="" onError={event => { event.currentTarget.hidden = true }} /></span>
              <span className="vx-talk-name"><strong><small>{slideNumber}</small> <Marked text={slideTitle} terms={terms} /></strong>
                {match && <span className="vx-slide-hit">{match.segments.map(({ text, hit }, j) => hit ? <mark key={j}>{text}</mark> : <Fragment key={j}>{text}</Fragment>)}</span>}
              </span>
              <span className="vx-fact vx-hit-kind">{excerpt?.label}</span>
            </> : <>
              <Cover facts={facts} title={title} />
              <span className="vx-talk-name"><strong><Marked text={title} terms={terms} /></strong>{showLocation && <TalkLocation talk={talk} terms={terms} />}
                {gallery && <small className="vx-tile-meta">{[slideCount == null ? '' : plural(slideCount, 'slide'), edited === '—' ? '' : edited].filter(Boolean).join(' · ')}</small>}
                {blocked && <small>Vault not reachable</small>}</span>
              <span className="vx-fact vx-slides">{slideCount ?? '—'}</span>
              <span className="vx-fact vx-handout">{handouts?.records.length ? plural(handouts.records.length, 'handout') : '—'}</span>
              <span className="vx-fact vx-edited">{edited}</span>
            </>}
          </button>
          {!blocked && <div className="vx-row-actions">
            <button type="button" className="vx-row-new-window" aria-label={`Open ${title} in new window`} title="Open in new window"
              disabled={busy} onClick={() => onOpen(row, true)}><ExternalLink size={15} /></button>
            <button type="button" className="vx-row-menu" aria-label={`Actions for ${title}`} aria-haspopup="menu" disabled={busy}
              onClick={event => onMenu(row, event)}><Ellipsis size={16} /></button>
          </div>}
        </div>
      </Fragment>
    })}
  </div>
}
