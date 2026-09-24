import { Check, FilePen, MonitorPlay, RotateCcw, Trash2 } from 'lucide-react'
import type { TalkTextModel } from '../../../preload/index'
import { parseNotesMarkdown, type NotesInline } from '../notesMarkdown'

export type NotesDisplayPart = {
  slug: string
  markdown: string
  approved: boolean
  node: TalkTextModel['outline'][number]
  index: number
  slides: number[]
}

function InlineNotes({
  content,
  onShowSlide,
  path
}: {
  content: NotesInline[]
  onShowSlide: (slideNumber: number) => void
  path: string
}): JSX.Element {
  return <>{content.map((token, index) => {
    const key = `${path}-${index}`
    if (token.kind === 'text') return <span key={key}>{token.text}</span>
    if (token.kind === 'strong') return <strong key={key}><InlineNotes content={token.children} onShowSlide={onShowSlide} path={key} /></strong>
    if (token.kind === 'added') return <span className={token.className} title={token.title} key={key}><InlineNotes content={token.children} onShowSlide={onShowSlide} path={key} /></span>
    return <button className={token.className} type="button" onClick={() => onShowSlide(token.slideNumber)} key={key}><MonitorPlay className="sr-ic" />{token.label}</button>
  })}</>
}

function NotesMarkdown({ markdown, onShowSlide }: { markdown: string; onShowSlide: (slideNumber: number) => void }): JSX.Element {
  return <div className="notes-markdown">{parseNotesMarkdown(markdown).map((block, index) => {
    const key = `block-${index}`
    if (block.kind === 'heading') {
      return block.level === 3
        ? <div className={block.className} key={key}>{block.text}</div>
        : <div className={block.className} key={key}>{block.slideNumber !== undefined ? <span className="sn">{block.slideNumber}</span> : null}{block.text}</div>
    }
    if (block.kind === 'paragraph') {
      return <div className={block.className} key={key}><p><InlineNotes content={block.children} onShowSlide={onShowSlide} path={key} /></p></div>
    }
    return <div className={`${block.className} ${block.kind === 'key-points' ? 'key-points' : ''}`} key={key}>
      {block.kind === 'key-points' ? <strong className="key-points-label">{block.label}</strong> : null}
      <ul>{block.items.map((item, itemIndex) => <li key={`${key}-${itemIndex}`}><InlineNotes content={item} onShowSlide={onShowSlide} path={`${key}-${itemIndex}`} /></li>)}</ul>
    </div>
  })}</div>
}

export default function NotesDocument({
  parts,
  busySlug,
  onApprove,
  onUnapprove,
  onEdit,
  onDiscard,
  onShowSlide
}: {
  parts: NotesDisplayPart[]
  busySlug: string | null
  onApprove: (slug: string) => void
  onUnapprove: (slug: string) => void
  onEdit: (slug: string) => void
  onDiscard: (slug: string) => void
  onShowSlide: (slideNumber: number) => void
}): JSX.Element {
  return <div className="tt-notes">{parts.map((part, partIndex) => {
    const firstSlide = part.slides.length ? Math.min(...part.slides) : null
    const lastSlide = part.slides.length ? Math.max(...part.slides) : null
    const busy = busySlug === part.slug
    return <section className={`tt-notes-part ${part.approved ? 'approved' : 'draft'}`} key={part.slug}>
      {partIndex > 0 ? <div className="hr" /> : null}
      <div className="part-head">
        <span className="n">{part.index}</span>
        <h2>{part.node.title}</h2>
        {part.approved ? <>
          <span className="pchip ok"><Check className="lt-icon" />Approved</span>
          <button className="pchip-action" type="button" disabled={busy} onClick={() => onUnapprove(part.slug)} title="Return this part to review"><RotateCcw className="lt-icon" />Review again</button>
        </> : <span className="pchip draft">Draft · in review</span>}
        {firstSlide !== null && lastSlide !== null ? <span className="rng">Slides {firstSlide}–{lastSlide}</span> : null}
      </div>
      {!part.approved ? <div className="review-bar">
        <span className="rb-t">The agent drafted this part from the transcript. Approve it, edit it, or discard it.</span>
        <button className="rb-btn approve" type="button" disabled={busy} onClick={() => onApprove(part.slug)}><Check className="lt-icon" />Approve</button>
        <button className="rb-btn" type="button" disabled={busy} onClick={() => onEdit(part.slug)}><FilePen className="lt-icon" />Edit</button>
        <button className="rb-btn discard" type="button" disabled={busy} onClick={() => onDiscard(part.slug)}><Trash2 className="lt-icon" />Discard &amp; redraw</button>
      </div> : null}
      <NotesMarkdown markdown={part.markdown} onShowSlide={onShowSlide} />
    </section>
  })}</div>
}
