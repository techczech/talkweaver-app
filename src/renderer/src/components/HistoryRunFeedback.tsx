// History, the selected Run's card (reactions ticket 06, drawing R1 in
// docs/design/2026-09-28-reactions-questions/round-2): "Questions · n" and "Reactions by slide",
// under "Instant slides shown" and in its classes, so the three read as one card. Every audience
// string (question text, name, custom label) is rendered as React text, never as markup.
import {
  Bookmark, Check, CircleCheck, CircleDashed, Frown, Lightbulb, MessageCircleMore, MessageCircleQuestion,
  Snail, ThumbsDown, ThumbsUp, X
} from 'lucide-react'
import type { ComponentType } from 'react'
import type { RunQuestion, RunReaction } from '../../../preload/index'
import { reactionCountsBySlide } from '../../../shared/run-feedback'

export type FeedbackSlide = { slideNumber: number; title: string }
type Slides = Record<string, FeedbackSlide | null> | undefined

// The registered vocabulary (surfaces-and-states.md § Trigger-line token), in the order chips show.
const REGISTERED: Array<[string, ComponentType<{ className?: string }>, string]> = [
  ['puzzled', Frown, 'Puzzled by this'],
  ['helped', Lightbulb, 'Helped me understand'],
  ['bookmark', Bookmark, 'Bookmarked'],
  ['agree', ThumbsUp, 'Agree'],
  ['disagree', ThumbsDown, 'Disagree'],
  ['yes', Check, 'Yes'],
  ['no', X, 'No'],
  ['more', MessageCircleMore, 'Tell me more'],
  ['slower', Snail, 'Slower, please'],
]
const ORDER = new Map(REGISTERED.map(([id], i) => [id, i]))
// A custom reaction is `custom:<label>`; the chip shows the label. (Prefix checked with startsWith,
// not a regex literal, which the Metadata Registry scan would read as a frontmatter key.)
const CUSTOM_PREFIX = 'custom:'
const customLabel = (reaction: string): string => reaction.startsWith(CUSTOM_PREFIX) ? reaction.slice(CUSTOM_PREFIX.length) : reaction

/** Wall-clock time of a moment `tMs` into a Run that started at `startedAt`. */
function runClock(startedAt: string, tMs: number): string {
  const d = new Date((Date.parse(startedAt) || 0) + tMs)
  return Number.isFinite(d.getTime()) ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : ''
}

function slideLabel(slides: Slides, slideId: string): { number: string; title: string } {
  const slide = slides?.[slideId]
  if (slide) return { number: String(slide.slideNumber), title: slide.title }
  return { number: '–', title: slides === undefined ? slideId : 'A slide no longer in the talk' }
}

export function RunQuestions({ questions, startedAt, slides }: { questions: RunQuestion[]; startedAt: string; slides: Slides }): JSX.Element {
  const answered = questions.filter((q) => q.answered).length
  // Latest first, as drawn.
  const ordered = [...questions].sort((a, b) => b.tMs - a.tMs)
  return (
    <div className="isl rq" data-history-questions onClick={(e) => e.stopPropagation()}>
      <div className="isl-h">
        <span className="t"><MessageCircleQuestion className="lt-icon" /> Questions · {questions.length}</span>
        <small>Asked on phones during the talk; only you saw them. {answered === 1 ? '1 marked answered.' : `${answered} marked answered.`}</small>
      </div>
      {ordered.map((q, i) => {
        const slide = slideLabel(slides, q.slideId)
        return (
          <div className="isl-row" key={q.id ?? `${q.tMs}-${i}`} data-question-slide={q.slideId}>
            <div className="isl-th"><span className="rq-num">{slide.number}</span></div>
            <div className="isl-what">
              <div className="isl-kind">Slide {slide.number} · {slide.title}</div>
              <div className="isl-text">{q.text}</div>
            </div>
            <div className="isl-when"><b>{runClock(startedAt, q.tMs)}</b> · {q.name ? q.name : <i>no name</i>}</div>
            {q.answered
              ? <span className="rq-state done"><CircleCheck className="lt-icon" /> Answered</span>
              : <span className="rq-state"><CircleDashed className="lt-icon" /> Not answered</span>}
          </div>
        )
      })}
    </div>
  )
}

export function RunReactions({ reactions, slides }: { reactions: RunReaction[]; slides: Slides }): JSX.Element | null {
  const bySlide = reactionCountsBySlide(reactions)
  if (!bySlide.length) return null
  const rows = bySlide.map((row, i) => ({ ...row, i, slide: slideLabel(slides, row.slideId), number: slides?.[row.slideId]?.slideNumber }))
    .sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity) || a.i - b.i)
  const total = rows.reduce((sum, row) => sum + Object.values(row.counts).reduce((a, n) => a + n, 0), 0)
  const bookmarks = rows.reduce((sum, row) => sum + (row.counts.bookmark ?? 0), 0)
  const puzzled = rows.map((row) => row.counts.puzzled ?? 0)
  const mostPuzzled = Math.max(0, ...puzzled)
  // "most puzzled" marks the one slide with the most Puzzled, when one stands out.
  const flagged = mostPuzzled > 0 && puzzled.filter((n) => n === mostPuzzled).length === 1 ? puzzled.indexOf(mostPuzzled) : -1
  return (
    <div className="isl rr" data-history-reactions onClick={(e) => e.stopPropagation()}>
      <div className="isl-h">
        <span className="t"><Lightbulb className="lt-icon" /> Reactions by slide · {total}</span>
        <small>Each slide’s own reactions, counted without names.{bookmarks ? ` ${bookmarks} ${bookmarks === 1 ? 'bookmark was' : 'bookmarks were'} saved on phones.` : ''}</small>
      </div>
      {rows.map((row, index) => {
        const chips = Object.entries(row.counts).sort(([a], [b]) => (ORDER.get(a) ?? 99) - (ORDER.get(b) ?? 99))
        const max = Math.max(...chips.map(([, n]) => n))
        return (
          <div className="rr-row" key={row.slideId} data-reaction-slide={row.slideId}>
            <span className="rr-n">{row.slide.number}</span>
            <span className="rr-t" title={row.slide.title}>{row.slide.title}{index === flagged ? <small>most puzzled</small> : null}</span>
            <span className="rr-counts">
              {chips.map(([reaction, n]) => {
                const registered = REGISTERED.find(([id]) => id === reaction)
                const Icon = registered?.[1]
                const name = registered?.[2] ?? customLabel(reaction)
                return (
                  <span key={reaction} className={`rr-c${n === max ? ' hi' : ''}${Icon ? '' : ' word'}`} title={name} aria-label={`${name}: ${n}`} data-reaction={reaction}>
                    {Icon ? <Icon className="lt-icon" /> : name} {n}
                  </span>
                )
              })}
            </span>
          </div>
        )
      })}
      <div className="rr-foot">Slides with no reactions are not listed.</div>
    </div>
  )
}
