import { useState } from 'react'
import {
  type LucideIcon, Check, ChevronLeft, ChevronRight, ExternalLink, Folders, Eye, LayoutTemplate, Library, PenLine, Presentation, Radio, Route, Share,
  SlidersHorizontal, Stethoscope
} from 'lucide-react'
import { GUIDE_TEXT } from '../../../shared/guide'
import { CHAPTER_ICONS, rowChords, shortChord, subgroupLabel, type Chapter } from '../../../shared/guide-chapters'
import {
  chapterComplete, chapterHistory, chapterHistoryText, finishedCountText, hasNoProgress, nextChapter, rowTried, triedCount,
  type GuideLearn
} from '../../../shared/guide-learn'
import type { TaskGroup } from '../../../shared/task-groups'

// Learn the commands (onboarding ticket 08; locked drawing states 04, 05 and 06): the Chapters card
// with the ten chapters and their history, and a chapter opened as This chapter: its commands by
// sub-group with their effective chords, each ticked the first time it is run by any route.
// Pure presentation: App owns the state and the actions.

const ICONS: Record<string, LucideIcon> = {
  'pen-line': PenLine, 'layout-template': LayoutTemplate, library: Library, eye: Eye, route: Route, presentation: Presentation,
  share: Share, folders: Folders, stethoscope: Stethoscope, 'sliders-horizontal': SlidersHorizontal
}
const iconOf = (task: TaskGroup): LucideIcon => ICONS[CHAPTER_ICONS[task]] ?? PenLine

// The row's chords (shortChord, rowChords) are shared with the presenter's Guide column (ticket 10).
export { rowChords, shortChord } from '../../../shared/guide-chapters'

/** Where a chapter's practice talk is, as App knows it. */
export interface PracticeState {
  talk: string
  section: string
  /** The practice talk is the one open in this window. */
  openNow: boolean
}

export interface GuideChaptersProps {
  chapters: Chapter[]
  learn: GuideLearn
  /** The chapter shown as This chapter, or null for the list. */
  selected: TaskGroup | null
  onSelect: (task: TaskGroup) => void
  onBack: () => void
  /** The effective chord text of a shortcut id (a rebinding applied). */
  chordOf: (shortcutId: string) => string
  practice: (task: TaskGroup) => PracticeState
  onOpenPractice: (task: TaskGroup) => void
  /** The row (by its id) that has just ticked in this window: it flashes. */
  flashId: string | null
}

export default function GuideChapters(props: GuideChaptersProps) {
  const chapter = props.selected ? props.chapters.find((c) => c.task === props.selected) : undefined
  return chapter ? <ChapterDetail {...props} chapter={chapter} /> : <ChapterList {...props} />
}

function ChapterList({ chapters, learn, onSelect }: GuideChaptersProps) {
  const fresh = hasNoProgress(learn)
  return (
    <div className="guide-card" data-guide-chapters>
      <div className="guide-card-bar">
        <b>{GUIDE_TEXT.chapters.bar}</b>
        <span data-guide-chapters-count>{finishedCountText(chapters, learn)}</span>
      </div>
      <ul className="guide-rows">
        {chapters.map((chapter, i) => {
          const Icon = iconOf(chapter.task)
          const history = chapterHistory(learn, chapter)
          const first = fresh && i === 0
          return (
            <li key={chapter.task}>
              <button
                type="button"
                className={`guide-crow${first ? ' guide-crow--hl' : ''}`}
                data-chapter-row={chapter.task}
                data-chapter-state={history.kind}
                onClick={() => onSelect(chapter.task)}
              >
                <span className="guide-cic"><Icon size={15} aria-hidden /></span>
                <span className="guide-crow-name">{chapter.task}</span>
                {first && <span className="guide-pill">{GUIDE_TEXT.chapters.startHere}</span>}
                {history.kind === 'finished'
                  ? <span className="guide-st guide-st--ok" data-chapter-status><Check size={12} aria-hidden />{chapterHistoryText(history)}</span>
                  : history.kind === 'tried'
                    ? (
                      <span className="guide-st guide-st--tr" data-chapter-status>
                        <i className="guide-mini"><u style={{ width: `${Math.round((history.tried / Math.max(1, history.total)) * 100)}%` }} /></i>
                        {chapterHistoryText(history)}
                      </span>
                    )
                    : <span className={`guide-st${history.kind === 'not-opened' ? ' guide-st--dim' : ''}`} data-chapter-status>{chapterHistoryText(history)}</span>}
                <ChevronRight size={12} className="guide-chv" aria-hidden />
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function ChapterDetail({ chapter, chapters, learn, onBack, onSelect, chordOf, practice, onOpenPractice, flashId }: GuideChaptersProps & { chapter: Chapter }) {
  const Icon = iconOf(chapter.task)
  const tried = triedCount(chapter, learn)
  const total = chapter.rows.length
  const history = chapterHistory(learn, chapter)
  const where = practice(chapter.task)
  const complete = chapterComplete(chapter, learn)
  const next = nextChapter(chapters, chapter.task)
  const finishedAt = learn.finished[chapter.task]
  // Sub-groups start open at the first one still to do (all closed when the chapter is done); the person's own toggles stay.
  const firstOpen = chapter.subgroups.find((g) => g.rows.some((row) => !rowTried(row, learn)))?.name
  const [toggled, setToggled] = useState<Record<string, boolean>>({})
  const isOpen = (name: string): boolean => toggled[name] ?? (name === firstOpen || chapter.subgroups.some((g) => g.name === name && g.rows.some((r) => r.id === flashId)))
  return (
    <div data-chapter-detail={chapter.task}>
      <div className="guide-cd-top">
        <button type="button" className="guide-back" data-chapter-back onClick={onBack}><ChevronLeft size={12} aria-hidden /> {GUIDE_TEXT.chapters.allChapters}</button>
      </div>
      <div className="guide-cd-title">
        <span className="guide-cic guide-cic--big"><Icon size={18} aria-hidden /></span>
        <div>
          <b>{chapter.task}</b>
          <small data-chapter-count>{history.kind === 'finished' ? chapterHistoryText(history) : chapterHistoryText({ kind: 'tried', tried, total })}</small>
        </div>
      </div>
      <div className="guide-bar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={tried}>
        <u style={{ width: `${total ? Math.round((tried / total) * 100) : 0}%` }} />
      </div>
      <div className="guide-gnote" data-chapter-practice>
        <b>{GUIDE_TEXT.chapters.practiceTalk}:</b> {where.talk}{where.openNow ? ` (${GUIDE_TEXT.chapters.openNow})` : ''}, section “{where.section}”.
      </div>
      {!where.openNow && (
        <button type="button" className="guide-gbtn guide-gbtn--wide" data-chapter-open-practice onClick={() => onOpenPractice(chapter.task)}>
          <ExternalLink size={12} aria-hidden /> {GUIDE_TEXT.chapters.openInExample}
        </button>
      )}
      <div className="guide-card" data-chapter-rows>
        <div className="guide-card-bar">
          <b>{GUIDE_TEXT.chapters.thisChapter}</b>
          <span data-chapter-rows-count>{tried} of {total}</span>
        </div>
        {chapter.subgroups.map((group) => {
          const done = group.rows.filter((row) => rowTried(row, learn)).length
          const open = isOpen(group.name)
          return (
            <div key={group.name} className="guide-cg" data-chapter-subgroup={group.name}>
              <button type="button" className="guide-cg-h" aria-expanded={open} onClick={() => setToggled((all) => ({ ...all, [group.name]: !open }))}>
                <span className="guide-tw" aria-hidden>{open ? '▾' : '▸'}</span>
                <b>{subgroupLabel(group.name)}</b>
                <span className="guide-gd">{done} of {group.rows.length}</span>
              </button>
              {open && group.rows.map((row) => {
                const on = rowTried(row, learn)
                const chords = rowChords(row, chordOf)
                return (
                  <div
                    key={row.id}
                    className={`guide-vrow${on ? ' guide-vrow--ticked' : ''}${flashId === row.id ? ' guide-vrow--flash' : ''}`}
                    data-command-row={row.id}
                    data-ticked={on ? 'true' : 'false'}
                    data-row-kind={row.merged ?? 'single'}
                  >
                    <span className="guide-tick" aria-hidden>{on ? <Check size={11} /> : null}</span>
                    <span className="guide-vrow-name">{row.label}</span>
                    {chords.length > 0
                      ? chords.map((chord) => <kbd key={chord} className="guide-key">{shortChord(chord)}</kbd>)
                      : row.merged === 'variants' ? null : <span className="guide-nokey">{GUIDE_TEXT.chapters.noKey}</span>}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
      {chapter.live.length > 0 && (
        <div className="guide-live-note" data-chapter-live-note>
          <Radio size={13} aria-hidden />
          <span><b>{GUIDE_TEXT.chapters.liveNote(chapter.live.length).lead}</b>{GUIDE_TEXT.chapters.liveNote(chapter.live.length).rest}</span>
        </div>
      )}
      {complete && finishedAt !== undefined && (
        <div className="guide-finished" data-chapter-finished>
          <span className="guide-st guide-st--ok"><Check size={12} aria-hidden />{chapterHistoryText({ kind: 'finished', at: finishedAt })}</span>
          {next && <button type="button" className="guide-gbtn guide-gbtn--pri" data-chapter-next onClick={() => onSelect(next.task)}>{GUIDE_TEXT.chapters.next}: {next.task} <ChevronRight size={12} aria-hidden /></button>}
        </div>
      )}
    </div>
  )
}
