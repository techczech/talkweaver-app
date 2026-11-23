import { useMemo } from 'react'
import { ArrowLeft, Check, Image, Inbox, Lightbulb, Merge, Split, TriangleAlert } from 'lucide-react'
import { BREAKDOWNS, breakdownChoices, planSketch, type SketchSlide } from '../../../shared/sketch-breakdown'
import {
  joinSketchSlide, precedingSlide, reviewSlides, slideLines, splitSketchSlide, undecidedLines,
  type LineFate, type SketchReview as Review,
} from '../../../shared/sketch-review'

function PlacementChip({ count }: { count: number }) {
  return <span className={`tw-sketch-chip ${count ? 'is-warning' : 'is-placed'}`}>
    {count ? <TriangleAlert size={12} aria-hidden="true" /> : <Check size={12} aria-hidden="true" />}
    {count ? `${count} ${count === 1 ? 'line' : 'lines'} to decide` : 'Every line placed'}
  </span>
}

export function SketchBreakdowns({ text, pictures, choose, onBack }: {
  text: string
  pictures: ReadonlyMap<string, string>
  choose: (review: Review) => void
  onBack: () => void
}) {
  const plans = useMemo(() => breakdownChoices(text).map(kind => planSketch(text, kind, pictures)), [text, pictures])
  const prose = plans[0]?.kind === 'paragraph'
  const count = plans[0]?.lines.length ?? 0
  const paragraphs = plans[0]?.slides.length ?? 0
  return <div className="tw-sketch-breakdowns">
    <h2>{plans.length === 4 ? 'Four' : 'Three'} ways to break this into slides</h2>
    <p>{prose && `The automatic breakdowns read this sketch as ${paragraphs} ${paragraphs === 1 ? 'paragraph' : 'paragraphs'}. `}
      Each one uses all {count} {count === 1 ? 'line' : 'lines'} of your sketch and changes no words. Choose the closest. You can move the cuts on the next screen. Nothing is added to the talk yet.</p>
    {prose && <div className="tw-sketch-notice is-info">
      <Lightbulb size={16} aria-hidden="true" />
      <span>To get slides with points, start lines with “-” in the sketch. A short line on its own becomes a section.</span>
      <button type="button" className="tw-btn tw-btn--secondary" onClick={onBack}>Back to the sketch</button>
    </div>}
    <div className="tw-sketch-options">
      {plans.map(plan => {
        const occupied = new Set(plan.slides.map(slide => slide.section))
        const sectionCount = plan.sections.filter(section => occupied.has(section.key)).length
        return <button key={plan.kind} data-breakdown={plan.kind} type="button" className="tw-sketch-option" onClick={() => choose({ ...plan, fates: {} })}>
          <strong>{BREAKDOWNS[plan.kind].label}</strong>
          <span className="tw-sketch-count"><b>{plan.slides.length}</b> {plan.slides.length === 1 ? 'slide' : 'slides'}
            {sectionCount > 0 && `${occupied.has(0) ? ' · ' : ' in '}${sectionCount} ${sectionCount === 1 ? 'section' : 'sections'}`}</span>
          <span className="tw-sketch-description">{BREAKDOWNS[plan.kind].description}</span>
          <span className="tw-sketch-film" aria-hidden="true">{plan.slides.slice(0, 9).map(slide => <SketchSlidePreview key={slide.key} slide={slide} />)}</span>
          <PlacementChip count={plan.undecided.length} />
        </button>
      })}
    </div>
  </div>
}

export function SketchSlidePreview({ slide }: { slide: SketchSlide }) {
  return <span className={`tw-sketch-mini${slide.points.length || slide.pictures.length ? '' : ' is-statement'}`}>
    <strong>{slide.title}</strong>
    {slide.points.length > 0 && <ul>{slide.points.slice(0, 5).map((point, index) => <li key={index}>{point.text}</li>)}</ul>}
    {slide.pictures.length > 0 && <small><Image size={10} aria-hidden="true" /> Picture</small>}
  </span>
}

const FATE_LABEL: Record<LineFate, string> = {
  notes: 'In the speaker notes of the slide above',
  slide: 'On its own slide',
  sketch: 'In the sketch only',
}

function SketchSourceText({ raw, undecided }: { raw: string; undecided: boolean }) {
  const text = raw.trim()
  if (/^\[picture:\s*[^\]]+\]$/i.test(text)) {
    return <span className={`tw-sketch-chip tw-sketch-source-picture ${undecided ? 'is-warning' : 'is-info'}`}>
      <Image size={12} aria-hidden="true" />{text}
    </span>
  }
  return <span className={undecided ? 'is-undecided' : undefined}>{text.replace(/^(?:#{1,6}|[-*+•–]|\d+[.)])[ \t]+/, '')}</span>
}

export default function SketchReview({ review, change, otherWays, cancel, add, place, busy = false }: {
  review: Review
  change: (next: Review) => void
  otherWays: () => void
  cancel: () => void
  add?: () => void
  place: string
  busy?: boolean
}) {
  const slides = reviewSlides(review)
  const undecided = new Set(undecidedLines(review))
  const added = slides.filter(slide => !slide.aside)
  const aside = slides.length - added.length
  const cuts = new Map<number, string[]>()
  const sectionLines = new Set(review.sections.map(section => section.line))
  const titleLines = new Set(slides.flatMap(slide => slide.titleLines))
  const occupied = new Set([...slides.map(slide => slide.section), ...review.undecided.map(line => line.section)])
  const sections = review.sections.filter(section => occupied.has(section.key))
  for (const section of sections) cuts.set(section.line, ['Section'])
  let number = 0
  for (const slide of slides) {
    const first = Math.min(...slideLines(slide).filter(line => line > 0))
    const cut = slide.aside ? 'Kept aside' : `Slide ${++number}`
    cuts.set(first, [...(cuts.get(first) ?? []), cut])
  }
  const setFate = (line: number, fate?: LineFate) => change({ ...review, fates: { ...review.fates, [line]: fate } })
  const editSlide = (key: number, patch: Partial<SketchSlide>) => change({
    ...review, slides: review.slides.map(slide => slide.key === key ? { ...slide, ...patch } : slide),
  })
  const noun = added.length === 1 ? 'slide' : 'slides'
  const blankTitle = slides.some(slide => !slide.title.trim())
  return <div className="tw-sketch-review">
    <div className="tw-sketch-review-columns">
      <div className="tw-sketch-source">
        <h2 className="tw-sketch-label">Your sketch, with the cuts</h2>
        {review.lines.map(line => <div key={line.number}>
          {cuts.get(line.number)?.map((cut, cutIndex) => <div className={`tw-sketch-cut${cut === 'Section' ? ' is-section' : ''}`} key={cutIndex}>{cut}</div>)}
          <div className={`tw-sketch-line${sectionLines.has(line.number) ? ' is-section' : titleLines.has(line.number) ? ' is-title' : /^\s{2,}|^\t/.test(line.raw) ? ' is-detail' : ''}`}>
            <SketchSourceText raw={line.raw} undecided={undecided.has(line.number)} />
          </div>
        </div>)}
      </div>
      <div className="tw-sketch-proposals">
        <div className="tw-sketch-review-head"><h2 className="tw-sketch-label">Slides it will make</h2><button className="tw-sketch-link" type="button" disabled={busy} onClick={otherWays}><ArrowLeft size={13} aria-hidden="true" />Other ways to break it up</button></div>
        {[{ key: 0, text: '' }, ...sections].map(({ key: section, text }) => <div key={section} className="tw-sketch-proposal-section">
          {section !== 0 && <h3 className="tw-sketch-label">{text}</h3>}
          {slides.filter(slide => slide.section === section).map(slide => {
            const i = review.slides.findIndex(candidate => candidate.key === slide.key)
            const previous = review.slides[i - 1]
            return <div key={slide.key} className={`tw-sketch-proposal${slide.aside ? ' is-aside' : ''}`}>
              <SketchSlidePreview slide={slide} />
              <div>
                {i >= 0 ? <input className="tw-sketch-slide-title" aria-label="Proposed slide title" aria-invalid={!slide.title.trim() || undefined} value={slide.title} disabled={busy} onChange={event => editSlide(slide.key, { title: event.target.value })} /> : <strong>{slide.title}</strong>}
                <div className="tw-sketch-slide-meta">{slide.points.length ? `${slide.points.length} ${slide.points.length === 1 ? 'point' : 'points'}` : 'One large sentence'}{slide.pictures.length > 0 && ` · ${slide.pictures.length} ${slide.pictures.length === 1 ? 'picture' : 'pictures'}`}{slide.aside && ' · stays in the Scratchpad'}</div>
                <div className="tw-sketch-card-actions">
                  {previous?.section === slide.section && previous.aside === slide.aside && <button className="tw-btn tw-btn--secondary" type="button" disabled={busy} onClick={() => change(joinSketchSlide(review, i))}><Merge size={13} aria-hidden="true" />Join with the one above</button>}
                  {i >= 0 && slide.points.length > 1 && <button className="tw-btn tw-btn--secondary" type="button" disabled={busy} onClick={() => change(splitSketchSlide(review, i))}><Split size={13} aria-hidden="true" />One slide per point</button>}
                  {i >= 0 && <button className="tw-btn tw-btn--secondary" type="button" disabled={busy} onClick={() => editSlide(slide.key, { aside: !slide.aside })}><Inbox size={13} aria-hidden="true" />{slide.aside ? 'Add it after all' : 'Not yet: keep in Scratchpad'}</button>}
                </div>
              </div>
            </div>
          })}
          {review.undecided.filter(line => line.section === section).map(line => <div key={line.line} className={`tw-sketch-line-choice ${undecided.has(line.line) ? 'is-warning' : 'is-placed'}`}>
            <div>{undecided.has(line.line) && <><TriangleAlert size={13} aria-hidden="true" />{' '}
              <b>{line.reason === 'missing-picture' ? 'This picture is missing from the talk:' : 'This line is not a point or a heading:'}</b>{' '}</>}“{line.text}”</div>
            {undecided.has(line.line) ? <div className="tw-sketch-card-actions">
              <button className="tw-btn tw-btn--secondary" type="button" disabled={busy || !precedingSlide(review, line.line, section)} onClick={() => setFate(line.line, 'notes')}>Put it in the notes of the slide above</button>
              <button className="tw-btn tw-btn--secondary" type="button" disabled={busy} onClick={() => setFate(line.line, 'slide')}>Make it a slide</button>
              <button className="tw-btn tw-btn--secondary" type="button" disabled={busy} onClick={() => setFate(line.line, 'sketch')}>Leave it in the sketch</button>
            </div> : <div>{FATE_LABEL[review.fates[line.line]!]} <button className="tw-btn tw-btn--secondary" type="button" disabled={busy} onClick={() => setFate(line.line)}>Change</button></div>}
          </div>)}
        </div>)}
      </div>
    </div>
    <div className="tw-sketch-foot">
      <strong>{added.length} {noun} to add{aside > 0 && ` · ${aside} kept in the Scratchpad`}</strong>
      <span role="status"><PlacementChip count={undecided.size} />
        {blankTitle && <span className="tw-sketch-chip is-warning">Give each slide a title before adding.</span>}</span>
      {added.length > 0 && <span>{place}</span>}
      <button className="tw-btn tw-btn--secondary" type="button" disabled={busy} onClick={cancel}>Cancel</button>
      <button className="tw-btn tw-btn--primary" type="button" disabled={!add || busy || Boolean(undecided.size) || blankTitle || !slides.length} onClick={add}>{added.length ? `Add ${added.length} ${noun} to the talk` : 'Keep proposals in the Scratchpad'}</button>
    </div>
  </div>
}
