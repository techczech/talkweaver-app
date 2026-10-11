import { Fragment } from 'react'
import { Check, ChevronLeft, ChevronRight, CirclePlay } from 'lucide-react'
import { HOW_BAR, HOW_TOPICS, TOPIC_STATUS, TOPIC_TRY_LABEL, howReadCount, isRead, type TopicTarget } from '../../../shared/guide-topics'
import type { GuideLearn } from '../../../shared/guide-learn'
import TopicPicture from './GuideTopicPictures'

// How it works (onboarding ticket 11; locked drawing states 08 and 09): ten topics, each Not opened or
// Read, and one topic open as a heading, its sentences, one picture and one Try it. Pure presentation:
// App owns the open topic, the read marks and what Try it does.

/** Text with `{statement}`-style triggers in backticks drawn as code. */
export function Inline({ text }: { text: string }): JSX.Element {
  return <>{text.split(/`([^`]+)`/).map((part, i) => (i % 2 ? <code key={i} className="guide-code">{part}</code> : <Fragment key={i}>{part}</Fragment>))}</>
}

export interface GuideHowProps {
  learn: GuideLearn
  /** The open topic's id, or null for the list. */
  openId: string | null
  onOpen: (id: string) => void
  onBack: () => void
  onTry: (target: TopicTarget) => void
}

export default function GuideHowItWorks({ learn, openId, onOpen, onBack, onTry }: GuideHowProps): JSX.Element {
  const index = openId ? HOW_TOPICS.findIndex((topic) => topic.id === openId) : -1
  if (index < 0) {
    return (
      <div className="guide-card" data-guide-how>
        <div className="guide-card-bar"><b>{HOW_BAR}</b><span data-guide-how-count>{howReadCount(learn)}</span></div>
        <ul className="guide-rows">
          {HOW_TOPICS.map((topic, i) => {
            const read = isRead(learn, topic.id)
            return (
              <li key={topic.id}>
                <button type="button" className="guide-crow guide-trow" data-topic-row={topic.id} data-topic-state={read ? 'read' : 'none'} onClick={() => onOpen(topic.id)}>
                  <span className="guide-n">{i + 1}</span>
                  <span className="guide-crow-name">{topic.title}</span>
                  {read
                    ? <span className="guide-st guide-st--ok" data-topic-status><Check size={12} aria-hidden />{TOPIC_STATUS.read}</span>
                    : <span className="guide-st guide-st--dim" data-topic-status>{TOPIC_STATUS.none}</span>}
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    )
  }
  const topic = HOW_TOPICS[index]
  const go = (to: number): void => onOpen(HOW_TOPICS[to].id)
  return (
    <div data-topic-detail={topic.id}>
      <div className="guide-cd-top guide-tnav">
        <button type="button" className="guide-back" data-topic-back onClick={onBack}><ChevronLeft size={12} aria-hidden /> {HOW_BAR}</button>
        <span className="guide-tpos" data-topic-position>{index + 1} of {HOW_TOPICS.length}</span>
        <span className="guide-tarrows">
          <button type="button" className="guide-sq" aria-label="Previous topic" data-topic-prev disabled={index === 0} onClick={() => go(index - 1)}><ChevronLeft size={13} aria-hidden /></button>
          <button type="button" className="guide-sq" aria-label="Next topic" data-topic-next disabled={index === HOW_TOPICS.length - 1} onClick={() => go(index + 1)}><ChevronRight size={13} aria-hidden /></button>
        </span>
      </div>
      <h2 className="guide-th" data-topic-title>{topic.title}</h2>
      {topic.sentences.map((sentence, i) => <p key={i} className="guide-tp" data-topic-sentence><Inline text={sentence} /></p>)}
      <div className="guide-pic-card"><TopicPicture picture={topic.picture} /></div>
      <div className="guide-try" data-topic-try>
        <button type="button" className="guide-try-btn" data-topic-try-button onClick={() => onTry(topic.tryIt.target)}><CirclePlay size={13} aria-hidden /> {TOPIC_TRY_LABEL}</button>
        <span className="guide-try-text"><b>{topic.tryIt.lead}</b> <Inline text={topic.tryIt.does} /></span>
      </div>
    </div>
  )
}
