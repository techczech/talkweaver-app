import { highlightSegments, readingLine, resultsHeaderModel, type HighlightRange, type TalkSearchHit, type TalkSearchResult } from '../../../../shared/talk-search'
import { quietSearchLine } from './model'

// Talk-search pieces of the Talks browser (ADR-0029 §1; frames L5, L7, L9, L10): the marked
// title, line two of a result row, and the header above the results.

export function Marked({ text, ranges }: { text: string; ranges: HighlightRange[] }): JSX.Element {
  if (ranges.length === 0) return <>{text}</>
  return <>{highlightSegments(text, ranges).map((seg, i) => (seg.hit ? <mark key={i}>{seg.text}</mark> : <span key={i}>{seg.text}</span>))}</>
}

/** Line two of a search result: the field that matched and its fragment, or — when the title
 *  matched every word — where the talk lives and when it was last given. */
export function SearchLine({ hit, focusPath }: { hit: TalkSearchHit; focusPath: string }): JSX.Element {
  if (hit.match) {
    return (
      <span className="tl-row-sub tl-row-match" title={`${hit.match.label} ${hit.match.text}`}>
        <em>{hit.match.label}</em> <Marked text={hit.match.text} ranges={hit.match.highlights} />
      </span>
    )
  }
  const quiet = quietSearchLine(hit, focusPath, new Date().getFullYear())
  return <span className="tl-row-sub">{quiet || 'vault root'}</span>
}

/** The quiet still-reading line (L9) and the results header (L5, L7). */
export function SearchHead({ result, shown, onSearchEverywhere }: {
  result: TalkSearchResult
  shown: number
  onSearchEverywhere: () => void
}): JSX.Element {
  const reading = readingLine(result)
  const head = resultsHeaderModel(result, shown)
  return (
    <>
      {reading && (
        <div className="tl-res-note" role="status">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
          {reading}
        </div>
      )}
      {shown > 0 && (
        <div className="tl-res-head">
          <span>{head.count}</span>
          <span className="tl-res-scope">
            <span className="tl-res-where">{head.scope}{head.everywhere != null ? ' ·' : ''}</span>
            {head.everywhere != null && (
              <button type="button" className="tl-res-wide" onClick={onSearchEverywhere}>search everywhere ({head.everywhere})</button>
            )}
          </span>
        </div>
      )}
    </>
  )
}
