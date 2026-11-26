import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, Check, CircleCheck, CodeXml, FileDiff, FileText, HardDrive, Monitor, ShieldCheck, Undo2 } from 'lucide-react'
import type { SlideMergeChoice, SlideMergeChoices, SlideMergeDiffSpan, SlideMergeSide } from '../../../shared/outline-merge'
import { summarizeSlideMerge, WHOLE_TALK_MERGE_KEY, type SlideMergeReview, type SlideMergeReviewRow } from '../../../shared/outline-slide-merge'
import { changedAtLabel } from '../lib/outlineDiskChange'
import { mergeResultText, mergeSideName, mergeStatusLabel, revealMergeArchive, slideChoiceWarning, slideSourceLabel } from './outlineMergeCopy'
import ReviewChangedLines from './ReviewChangedLines'
import './SlideMergeCards.css'

const sides = ['mine', 'disk'] as const
type Pictures = Partial<Record<SlideMergeSide, Record<number, string>>>
type Choose = (key: string, choice: SlideMergeChoice) => void

function ChoiceButton({ choice, selected, label, description, warning, disabled, onClick }: {
  choice: SlideMergeChoice; selected?: SlideMergeChoice; label: string; description?: string
  warning?: string; disabled: boolean; onClick(): void
}) {
  const hint = warning ?? 'Nothing is discarded.'
  return <button type="button" className="merge-cards-choice" aria-pressed={selected === choice}
    aria-label={label} aria-description={[description, hint].filter(Boolean).join(' ')} disabled={disabled} onClick={onClick}>
    <span className="merge-cards-choice-dot" />
    <span><strong>{label}</strong>
      {description && <span className="merge-cards-choice-description">{description}</span>}
      <span className={warning ? 'merge-cards-warning' : 'merge-cards-safe'}>
        {warning ? <AlertTriangle size={12} /> : <CircleCheck size={12} />}{hint}
      </span>
    </span>
  </button>
}

function WordChanges({ spans }: { spans: readonly SlideMergeDiffSpan[] }) {
  return <div className="merge-cards-diff">
    <div><strong>Word changes</strong> <del>only in this window</del> <ins>only on disk</ins></div>
    <pre>{spans.map((span, i) => {
      const text = span.text.replace(/\n[ \t]*\n+/g, '\n')
      if (span.kind === 'removed') return <del key={i}>{text}</del>
      if (span.kind === 'added') return <ins key={i}>{text}</ins>
      return i === spans.length - 1 ? text.trimEnd() : text
    })}</pre>
  </div>
}

function SourceText({ sources, withChanges = false }: { sources: { base?: string; mine?: string; disk?: string }; withChanges?: boolean }) {
  return <div className="merge-cards-source-text">
    {([...sides, 'base'] as const).map(side => <div key={side}>
      <h4>{side === 'base' ? 'Last save' : mergeSideName[side]}</h4>
      <pre tabIndex={0}>{sources[side] ?? 'Slide absent'}</pre>
    </div>)}
    {withChanges && <ReviewChangedLines before={sources.mine ?? ''} after={sources.disk ?? ''} />}
  </div>
}

function SlidePicture({ row, side, selected, picture, saved, disk }: {
  row: SlideMergeReviewRow; side: SlideMergeSide; selected?: SlideMergeChoice; picture?: Record<number, string>
  saved: string; disk: string
}) {
  const version = row[side]
  const isChosen = selected === side || selected === 'both'
  const tag = selected && (isChosen
    ? !version ? 'Left out of the file' : selected === 'both' && side === 'disk' ? 'Added after it' : 'Goes in the file'
    : version ? 'Not used' : undefined)
  const Icon = side === 'mine' ? Monitor : HardDrive
  const url = version && picture?.[version.line]
  const caption = side === 'mine' ? 'Not in this window' : 'Not in the file'
  return <figure className="merge-cards-picture" data-side={side}>
    <figcaption><Icon size={14} /><div><strong>{mergeSideName[side]}</strong><small>{slideSourceLabel(row, side, saved, disk)}</small></div></figcaption>
    <div className="merge-cards-stage" data-selection={tag ? isChosen ? 'chosen' : 'unused' : undefined}>
      {version && url ? <img src={url} loading="lazy" alt={`${version.title} — ${mergeSideName[side]}`} />
        : <span>{!version ? caption : picture ? 'Preview unavailable' : 'Loading picture…'}</span>}
      {tag && <small className="merge-cards-picture-tag">{tag}</small>}
    </div>
  </figure>
}

function SlideCard({ row, pictures, selected, chosenByUser, saved, disk, disabled, choose }: {
  row: SlideMergeReviewRow; pictures: Pictures; selected?: SlideMergeChoice; chosenByUser: boolean
  saved: string; disk: string; disabled: boolean; choose: Choose
}) {
  const [fullText, setFullText] = useState(false)
  const shown = row.mine ?? row.disk ?? row.base!
  const section = row.sections.mine ?? row.sections.disk ?? row.sections.base
  const reviewRequired = row.defaultChoice === undefined
  const captions = {
    mine: row.mine ? row.base ? "Keep this window's version" : "Keep this window's new slide" : 'Leave it out, as in this window',
    disk: row.disk ? row.base ? 'Take the disk version' : 'Take the new slide from disk' : 'Leave it out, as on disk',
  }
  return <article className="merge-cards-card" data-merge-key={row.key} data-needs-choice={!selected || undefined}>
    <header>
      <span className="merge-cards-pill">{shown.number}</span><h3>{shown.title}</h3>
      {section && <span>in {section}</span>}
      <span className="merge-cards-pill" data-warning={reviewRequired || undefined}>{mergeStatusLabel[row.status]}</span>
      <span className="merge-cards-pill" data-warning={!selected || undefined}>
        {!selected ? 'Choose' : chosenByUser ? 'Chosen' : 'Set for you'}
      </span>
      <button type="button" className="merge-cards-link" aria-expanded={fullText} disabled={disabled} onClick={() => setFullText(!fullText)}>
        <CodeXml size={14} />{fullText ? 'Hide full text' : 'Show full text'}
      </button>
    </header>
    <div className="merge-cards-card-body">
      <div className="merge-cards-pictures">
        {sides.map(side => <SlidePicture key={side} row={row} side={side} selected={selected} picture={pictures[side]} saved={saved} disk={disk} />)}
      </div>
      <div className="merge-cards-choices" role="group" aria-label={`Version for ${shown.title}`}>
        {sides.map(side => <ChoiceButton key={side} choice={side} selected={selected} label={captions[side]}
          description={row[side] ? side === 'mine' ? 'The file gets the slide shown under This window.' : 'The file gets the slide shown under On disk.' : 'The slide is left out of the file.'}
          warning={slideChoiceWarning(row, side)} disabled={disabled} onClick={() => choose(row.key, side)} />)}
        {row.mine && row.disk && <ChoiceButton choice="both" selected={selected} label="Keep both (disk version added after)"
          description="The file gets two slides, with the disk version after this window’s version." disabled={disabled} onClick={() => choose(row.key, 'both')} />}
      </div>
    </div>
    <WordChanges spans={row.diff} />
    {fullText && <SourceText withChanges sources={{ base: row.base?.text, mine: row.mine?.text, disk: row.disk?.text }} />}
  </article>
}

interface Props {
  path: string; title: string; review: SlideMergeReview; busy: boolean; saving: boolean
  stale: 'disk' | 'review' | null; error: string | null; wholeTalk: boolean
  onApply(generation: string, choices: SlideMergeChoices): void
  onDismiss(): void
  onRefresh(): void
}

export default function SlideMergeCards({ path, title, review, busy, saving, stale, error, wholeTalk, onApply, onDismiss, onRefresh }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const [choices, setChoices] = useState<SlideMergeChoices>({})
  const [pictures, setPictures] = useState<Pictures>({})
  const [archiveMissing, setArchiveMissing] = useState(false)
  const whole = wholeTalk || review.duplicateIds.length > 0
  const [fullText, setFullText] = useState(false)
  const wholeChoice = choices[WHOLE_TALK_MERGE_KEY]
  const effectiveChoices = whole ? wholeChoice ? { [WHOLE_TALK_MERGE_KEY]: wholeChoice } : {} : choices
  const summary = summarizeSlideMerge(review, effectiveChoices)
  const ready = whole ? !!wholeChoice : !summary.unresolved.length
  const waiting = review.rows.filter(row => summary.unresolved.includes(row.key)).length
  const otherWaiting = summary.unresolved.length - waiting
  const waitingText = whole ? wholeChoice ? 'Whole version chosen' : 'Choose a whole version'
    : waiting ? `${waiting} ${waiting === 1 ? 'slide needs' : 'slides need'} your choice${otherWaiting ? ' · Also review the talk details or slide order' : ''}`
    : otherWaiting ? 'Review the talk details or slide order' : 'Every slide has a choice'
  const saved = changedAtLabel(review.lastSavedAt)
  const disk = changedAtLabel(review.diskChangedAt) + (new Date(review.diskChangedAt).toDateString() === new Date().toDateString() ? ' today' : '')
  const total = review.rows.length + review.unchanged
  const rowsByChoice = useMemo(() => [
    { label: 'Slides that need your choice', rows: review.rows.filter(row => !row.defaultChoice) },
    { label: 'Slides set to keep the change', rows: review.rows.filter(row => !!row.defaultChoice) },
  ], [review.rows])

  useLayoutEffect(() => {
    const element = dialog.current
    element?.showModal()
    heading.current?.focus({ preventScroll: true })
    return () => { element?.close() }
  }, [])
  useEffect(() => {
    if (whole) return
    let current = true
    for (const side of sides) {
      void window.tw.talk.slideMergePictures(path, review.generation, side).catch(() => ({}))
        .then(pictures => { if (current) setPictures(previous => ({ ...previous, [side]: pictures })) })
    }
    return () => { current = false }
  }, [path, review.generation, whole])

  const choose: Choose = (key, choice) => setChoices(previous => ({ ...previous, [key]: choice }))
  function nextChoice(): void {
    setFullText(false)
    requestAnimationFrame(() => {
      const first = dialog.current?.querySelector<HTMLElement>('[data-needs-choice] .merge-cards-choice:not(:disabled)')
      first?.focus({ preventScroll: true })
      first?.closest('[data-needs-choice]')?.scrollIntoView({ block: 'start' })
    })
  }
  function choicePair(key: string, selected: SlideMergeChoice | undefined, mine: string, disk: string, mineWarning?: string, diskWarning?: string): ReactNode {
    return <div className="merge-cards-choice-pair">
      <ChoiceButton choice="mine" selected={selected} label={mine} warning={mineWarning} disabled={busy} onClick={() => choose(key, 'mine')} />
      <ChoiceButton choice="disk" selected={selected} label={disk} warning={diskWarning} disabled={busy} onClick={() => choose(key, 'disk')} />
    </div>
  }

  const details = review.details
  const order = review.order
  return <dialog ref={dialog} className="merge-cards" aria-labelledby="merge-cards-title" data-testid="outline-merge-sheet"
    onCancel={event => { event.preventDefault(); if (!busy) onDismiss() }}>
    <header className="merge-cards-titlebar tw-window-drag">
      <FileDiff size={17} /><h2 id="merge-cards-title" ref={heading} tabIndex={-1}>This talk was changed outside TalkWeaver</h2>
      <span className="merge-cards-talk-title" title={title}>{title}</span>
      {!whole && <button type="button" disabled={busy} onClick={() => { setFullText(!fullText); body.current?.scrollTo(0, 0) }}>
        <CodeXml size={15} />{fullText ? 'Back to the slides' : 'Show full text of both versions'}
      </button>}
    </header>
    <div className="merge-cards-summary">
      <div className="merge-cards-headline">
        <h3>{review.rows.length} of {total} slides {review.rows.length === 1 ? 'differs' : 'differ'}</h3>
        <span>between this window and the file on disk</span>
        <button type="button" className="merge-cards-pill" data-warning={!ready || undefined} disabled={busy || ready || whole} onClick={nextChoice}>
          {ready ? <Check size={14} /> : <AlertTriangle size={14} />}{waitingText}
        </button>
      </div>
      <div className="merge-cards-counts">
        {Object.entries(mergeStatusLabel).map(([status, label]) => {
          const count = review.rows.filter(row => row.status === status).length
          return count > 0 && <span key={status} className="merge-cards-pill"><strong>{count}</strong> {label.toLowerCase()}</span>
        })}
      </div>
      <div className="merge-cards-sources">
        <span><Monitor size={14} /><strong>This window</strong> Edited since the last save at {saved}.</span>
        <span><HardDrive size={14} /><strong>On disk</strong> {review.fileName} changed at {disk}.</span>
      </div>
      {(stale || error) && <div className="merge-cards-notice" role="status">
        {stale === 'disk' && <strong>Changed again on disk</strong>}
        {error && <span>{error}</span>}
        {stale && <button type="button" disabled={busy} onClick={onRefresh}>{busy ? 'Refreshing…' : 'Refresh review'}</button>}
      </div>}
    </div>
    <div className="merge-cards-body" ref={body}>
      {whole ? <section className="merge-cards-meta" data-needs-choice={!wholeChoice || undefined}>
        <div><strong>The slides cannot be matched one by one.</strong>
          <p>Choose a whole version. The other version stays in the recovery copy.</p></div>
        {choicePair(WHOLE_TALK_MERGE_KEY, wholeChoice, "Keep this window's whole talk", 'Take the whole talk from disk',
          'Discards every change made on disk.', 'Discards every edit you made in this window since the last save.')}
      </section> : <>
        <section className="merge-cards-meta" data-needs-choice={details && summary.unresolved.includes(details.key) || undefined}>
          <div><FileText size={15} /><strong>Talk details</strong> {details
            ? <><span className="merge-cards-pill">{mergeStatusLabel[details.status]}</span><ReviewChangedLines before={details.mine} after={details.disk} /></>
            : <span>The same in this window and on disk</span>}</div>
          {details && choicePair(details.key, choices[details.key] ?? details.defaultChoice, "Keep this window's talk details", 'Take the talk details from disk',
            details.status !== 'changed-here' ? 'Discards the change made on disk to the talk details.' : undefined,
            details.diskDiscardsWindowEdits ? 'Discards your edit to the talk details.' : undefined)}
        </section>
        {order && <section className="merge-cards-meta" data-needs-choice={summary.unresolved.includes(order.key) || undefined}>
          <div><strong>Slide order</strong> <span className="merge-cards-pill">{mergeStatusLabel[order.status]}</span></div>
          {choicePair(order.key, choices[order.key] ?? order.defaultChoice, "Keep this window's slide order", 'Take the slide order from disk',
            order.status !== 'changed-here' ? 'Discards the slide order on disk.' : undefined,
            order.status !== 'changed-on-disk' ? 'Discards your slide order.' : undefined)}
        </section>}
      </>}
      {(fullText || whole) ? <SourceText sources={review.sources} /> : rowsByChoice.map(group => group.rows.length > 0 &&
        <section key={group.label} className="merge-cards-group" aria-label={group.label}>
          {review.rows.length > 1 && <h3>{group.label} <span>{group.rows.length}</span></h3>}
          {group.rows.map(row => <SlideCard key={row.key} row={row} pictures={pictures}
            selected={choices[row.key] ?? row.defaultChoice} chosenByUser={Object.hasOwn(choices, row.key)} saved={saved} disk={disk} choose={choose} disabled={busy} />)}
        </section>)}
    </div>
    <footer className="merge-cards-footer">
      <div className="merge-cards-receipt">
        <p role="status" className={ready ? undefined : 'merge-cards-warning'}>
          {saving ? 'Saving the merge… Editing is paused.' : ready
            ? <>After applying: <strong>{mergeResultText(summary)}</strong> {summary.unchanged} unchanged. The file will have {summary.total} {summary.total === 1 ? 'slide' : 'slides'}.</>
            : <><AlertTriangle size={14} /><strong>{waitingText}.</strong> {!whole && <button className="merge-cards-link" type="button" disabled={busy} onClick={nextChoice}>Show the next one</button>}</>}
        </p>
        <p><ShieldCheck size={13} /><span>Recovery saved at {changedAtLabel(review.recovery.savedAt)} with all three versions: last save, this window and disk. <button type="button" className="merge-cards-link" disabled={busy}
          onClick={() => { void revealMergeArchive(review.recovery.path).then(setArchiveMissing) }}>Show recovery copy</button></span></p>
        {archiveMissing && <p role="status">The recovery copy could not be opened. It may have expired.</p>}
        <p><Undo2 size={13} /><span>Undo (⌘Z) restores this window. After Undo and autosave, disk edits are only in recovery (20 copies per talk, up to 14 days).</span></p>
      </div>
      <div className="merge-cards-footer-actions">
        <button type="button" disabled={busy} onClick={onDismiss} aria-label="Decide later" aria-description="Nothing is written. The disk version stays in the file and this window keeps your unsaved text.">
          <strong>Decide later</strong><small>Nothing is written. The disk version stays in the file and this window keeps your unsaved text.</small>
        </button>
        <button type="button" className="merge-cards-apply" disabled={busy || !!stale || !ready} onClick={() => onApply(review.generation, effectiveChoices)}
          aria-label={saving ? 'Saving the merge' : 'Apply to the file'}>
          <strong><Check size={15} />{saving ? 'Saving the merge…' : 'Apply to the file'}</strong>
          <small>{saving ? 'Editing is paused' : stale ? 'Refresh the review first' : ready ? `Saves the talk with ${summary.total} ${summary.total === 1 ? 'slide' : 'slides'}` : waiting ? `Choose for ${waiting} more ${waiting === 1 ? 'slide' : 'slides'} first` : 'Finish choosing first'}</small>
        </button>
      </div>
    </footer>
  </dialog>
}
